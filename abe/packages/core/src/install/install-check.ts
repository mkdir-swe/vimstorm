/**
 * Factory install: a check is proven by serve (`abe install try`, the Checks part's check), never
 * by the session's own run. Serve runs it in the main checkout, outside the session's sandbox, with what `abe run` and
 * the Factory's checks get (the Abe env file's values and aws profile's keys of the environment
 * Checks recorded, CI's
 * `NODE_OPTIONS`), and answers pass or fail, its exit and the tail of what it said with every
 * injected value redacted. Only one of the repo's own checks runs so: a command CI runs, a static
 * check Read offers, or a package script, never one that installs dependencies or writes outside.
 * Pure: the rule, the data and its words.
 */
import { z } from 'zod';
import { outwardCommand, outwardWord } from './install-outward';
import { type ReadFindings } from './install-read';

/** How much of a check's output comes back: its last lines. */
export const CHECK_TAIL_LINES = 40;

/** One check serve ran: its name (null: a `--command` try), whether it passed, its exit, its tail. */
export const InstallCheckRun = z.object({
  name: z.string().nullable(),
  run: z.string(),
  ok: z.boolean(),
  exit: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  /** The last lines of what it printed, every injected value and env file value redacted. */
  tail: z.string(),
});
export type InstallCheckRun = z.infer<typeof InstallCheckRun>;

export const InstallCheckData = z.object({
  repo: z.string(),
  runs: z.array(InstallCheckRun),
  /**
   * Why the checks ran in dev without the install session's own database (`DATABASE_URL`), in
   * words with the fix (Docker not running); absent when they had it or needed none.
   */
  noDatabase: z.string().optional(),
});
export type InstallCheckData = z.infer<typeof InstallCheckData>;

/** A run as the record keeps it, by its command (`checkKey`): what the Checks part asks. */
export const CheckProof = z.object({
  ok: z.boolean(),
  exit: z.number().int().nullable(),
  at: z.string(),
});
export type CheckProof = z.infer<typeof CheckProof>;

/** A command as the record keys it: its words, one space between. */
export const checkKey = (run: string): string => run.trim().replace(/\s+/g, ' ');

export const installCheckText = (d: InstallCheckData): string =>
  [
    ...(d.noDatabase === undefined ? [] : [`no database: ${d.noDatabase}`]),
    ...d.runs.map((r) => {
      const head = `${r.ok ? 'pass' : 'fail'}  ${r.name ?? 'try'} (${r.run})  ${r.timedOut ? 'timed out' : `exit ${r.exit ?? 'none'}`}`;

      return r.ok || r.tail.trim() === ''
        ? head
        : `${head}\n${r.tail
            .split('\n')
            .map((l) => `  ${l}`)
            .join('\n')}`;
    }),
  ].join('\n');

/** The last `CHECK_TAIL_LINES` lines of `output`. */
export const checkTail = (output: string): string =>
  output.trimEnd().split('\n').slice(-CHECK_TAIL_LINES).join('\n');

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;

/** What a package manager installs with: never run in the person's main checkout. */
const INSTALL_VERBS = ['ci', 'install', 'i', 'add', 'update', 'upgrade'];

const SAFE_WORD = /^[\w./@%+=:,-]+$/;

/** The parts of a command between `&&`, `||`, `;`, `|` and lines. */
const partsOf = (command: string): string[] =>
  command
    .split(/&&|\|\||;|\||\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');

/** Whether a part runs a package manager's install (`npm ci`, `pnpm --dir web install`, bare `yarn`). */
const installsDeps = (part: string): boolean => {
  const [tool = '', ...rest] = part.split(/\s+/);

  if (!PACKAGE_MANAGERS.some((m) => m === tool)) return false;
  const verb = rest.find((w) => !w.startsWith('-'));

  return verb === undefined ? tool === 'yarn' : INSTALL_VERBS.includes(verb);
};

/** The package script a command runs (`[cd <dir> &&] <pm> [run] <script> [args]`); none: not one. */
const scriptRun = (command: string): { dir: string; script: string } | undefined => {
  const m = /^(?:cd\s+(\S+)\s*&&\s*)?(npm|pnpm|yarn|bun)\s+(.+)$/.exec(checkKey(command));

  if (m === null) return undefined;
  const dir = (m[1] ?? '.').replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';
  const words = (m[3] ?? '').split(' ');

  if (!SAFE_WORD.test(dir) || dir.split('/').includes('..') || dir.startsWith('/'))
    return undefined;
  if (!words.every((w) => SAFE_WORD.test(w))) return undefined;
  const first = words[0] ?? '';
  const script = first === 'run' || first === 'run-script' ? words[1] : first;

  if (script === undefined || script.startsWith('-')) return undefined;

  return { dir, script: m[2] === 'npm' && script === 't' ? 'test' : script };
};

/**
 * Why `command` is no check serve runs for the install, or null: it is one. One of the repo's
 * checks is a command CI runs, a static check Read offers, or a package script of the top's or a
 * workspace's (`npm test`, `cd web && pnpm run lint`). Never one that installs dependencies (the
 * checkout is the person's), nor one that writes outside (a deploy, `aws`, `cdk`).
 */
export const checkCommandWhyNot = (
  command: string,
  read: Pick<ReadFindings, 'ci' | 'scripts' | 'workspaces' | 'outward' | 'kind'> | null,
): string | null => {
  const key = checkKey(command);

  if (key === '') return 'it is empty';
  if (partsOf(key).some(installsDeps))
    return 'it installs dependencies: never in your main checkout';
  const outward = outwardCommand(key);

  if (outward !== undefined) return `it writes outside this machine (${outward})`;
  const ci = (read?.ci ?? []).flatMap((c) => c.commands).map(checkKey);
  const statics = (read?.kind?.checks ?? []).map((c) => checkKey(c.run));

  if (ci.includes(key) || statics.includes(key)) return null;
  const run = scriptRun(key);
  const packageScripts = (dir: string) =>
    dir === '.' ? (read?.scripts ?? {}) : read?.workspaces.find((w) => w.dir === dir)?.scripts;
  const scripts = run === undefined ? undefined : packageScripts(run.dir);

  if (run !== undefined && scripts?.[run.script] !== undefined) {
    const said = (read?.outward ?? []).find((o) => o.name === run.script && o.dir === run.dir);
    const word = outwardWord(run.script);

    if (said !== undefined) return `${run.script} writes outside this machine (${said.why})`;
    if (word !== undefined)
      return `${run.script} writes outside this machine (its name says ${word})`;

    return null;
  }

  return run === undefined
    ? "it is none of the repo's checks: give a command CI runs or a package script (npm test, cd web && npm run lint)"
    : `${run.dir === '.' ? 'package.json' : `${run.dir}/package.json`} has no script ${run.script}`;
};

/**
 * The listed checks serve has not seen pass (`runs`, by `checkKey`): one line each, never run
 * by serve or failed when it last ran.
 */
export const checksUnproven = (
  checks: readonly { name: string; run: string }[],
  runs: Readonly<Record<string, CheckProof>>,
): string[] =>
  checks.flatMap((c) => {
    const last = runs[checkKey(c.run)];

    if (last === undefined) return [`${c.name} (${c.run}) has not run: abe install try ${c.name}`];

    return last.ok
      ? []
      : [
          `${c.name} (${c.run}) failed when serve ran it (exit ${last.exit ?? 'none'}): fix it, or leave it out of checks: and tell the person what fails and why`,
        ];
  });
