/**
 * Checks (ticket #46, spec #35): once build says it is done, `serve` itself runs the deterministic
 * checks before any review: each `checks` entry's command in the worktree, then the two built-in
 * checks on the diff against the merge base, no deleted tests and no new suppressions. All green
 * moves the run on to review, any red back to build (`CHECKS` in `factory.ts`) with the failing
 * output typed into the session; every result is kept as Evidence in `.scratch/<card>/checks.md`.
 * A check no Layer gives a command is not configured, never green; when no check with a command
 * ran (a repo with no pack, #159) the checks are `none`: nothing was run, and the run says so.
 *
 * This module is the pure part: the plan from the merged settings, what a test file is, reading
 * git's diff for deleted tests and added suppressions, and the words written and typed.
 */
import { z } from 'zod';
import { type CheckEntry, isBuiltInCheck, type BuiltInCheck } from '../layer/settings/checks';
import { LOCALE } from '../session/session';

/** The longest a check's command may run before it is killed and counted red. */
export const CHECK_TIMEOUT_MS = 15 * 60_000;

/** Where a run's checks are kept, relative to its worktree (`.scratch/` is git-excluded). */
export const checksFile = (card: number): string => `.scratch/${card}/checks.md`;

/** What a step of the checks is: a command, a check named with no command yet, or a built-in. */
export type ChecksStep =
  | { kind: 'command'; name: string; run: string }
  | { kind: 'no-run'; name: string }
  | { kind: 'built-in'; name: BuiltInCheck };

/** The checks in the order they run: the commands (and named ones with none) as listed, then the built-ins. */
export const checksPlan = (entries: readonly CheckEntry[]): ChecksStep[] => {
  const steps = entries.map((e): ChecksStep => {
    if (isBuiltInCheck(e.name)) return { kind: 'built-in', name: e.name };

    return e.run === null
      ? { kind: 'no-run', name: e.name }
      : { ...e, kind: 'command', run: e.run };
  });

  return [
    ...steps.filter((s) => s.kind !== 'built-in'),
    ...steps.filter((s) => s.kind === 'built-in'),
  ];
};

/** aws in a check: its config and credentials files empty, no instance metadata (ADR 0029). */
export const CHECKS_NO_AWS_PROFILE = {
  AWS_CONFIG_FILE: '/dev/null',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_EC2_METADATA_DISABLED: 'true',
} as const;

/**
 * The environment a check's command runs with: the person's `HOME`, `USER`, `PATH`, `TMPDIR` and
 * locale, and `CI=true` (so test runners run once, not in watch mode). Nothing else of `serve`'s:
 * no tokens reach the code the agent wrote, nor its own `DATABASE_URL` (a check gets its session's
 * database, or its environment's Abe env file's, put over this).
 * aws reaches no profile of `~/.aws` (ADR 0029): only the short-lived keys the checks' environment
 * hands them, put over this.
 */
export const checksEnv = (parent: Readonly<Record<string, string | undefined>>) => {
  const env: Record<string, string> = { CI: 'true', ...CHECKS_NO_AWS_PROFILE };

  for (const name of ['HOME', 'USER', 'PATH', 'TMPDIR', ...LOCALE]) {
    const value = parent[name];

    if (value !== undefined && value !== '') env[name] = value;
  }

  return env;
};

const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** A glob as a regex source: `**` crosses folders, `*` and `?` stay within one. */
const globSource = (glob: string): string => {
  let out = '';

  for (let i = 0; i < glob.length; i += 1) {
    const c = glob.charAt(i);

    if (c === '*' && glob[i + 1] === '*') {
      i += 1;
      if (glob[i + 1] === '/') {
        i += 1;
        out += '(?:.*/)?';
      } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += escapeRe(c);
  }

  return out;
};

/**
 * What a `testFiles` pattern matches, as in `.gitignore`: one ending in `/` is a folder, anywhere
 * when it has no other `/`; one with no `/` is a file's name at any depth; any other is a path
 * from the repo's root.
 */
export const testFileRegex = (pattern: string): RegExp => {
  const folder = pattern.endsWith('/');
  const body = folder ? pattern.slice(0, -1) : pattern;
  const anchored = body.includes('/');
  const glob = globSource(body.replace(/^\//, ''));
  const start = anchored ? '^' : '(?:^|/)';

  return new RegExp(folder ? `${start}${glob}/` : `${start}${glob}$`);
};

export const isTestFile = (path: string, patterns: readonly string[]): boolean =>
  patterns.some((p) => testFileRegex(p).test(path));

/** One path of `git diff --name-status -z`: its status letter, and where a rename or copy went. */
export type PathChange = { status: string; path: string; to: string | null };

/** `git diff --name-status -z` read: `X\0path\0`, renames and copies `R100\0from\0to\0`. */
export const parseNameStatus = (text: string): PathChange[] => {
  const parts = text.split('\0');
  const changes: PathChange[] = [];

  for (let i = 0; i < parts.length;) {
    const head = parts[i] ?? '';
    const status = head.charAt(0);

    if (status === '') {
      i += 1;
      continue;
    }
    const path = parts[i + 1] ?? '';
    const two = status === 'R' || status === 'C';

    changes.push({ status, path, to: two ? (parts[i + 2] ?? '') : null });
    i += two ? 3 : 2;
  }

  return changes;
};

/**
 * The test files at the merge base that are gone now: deleted, or moved to a path that is no test
 * file. Each as a line for the output.
 */
export const deletedTests = (
  changes: readonly PathChange[],
  patterns: readonly string[],
): string[] =>
  changes.flatMap((c) => {
    if (!isTestFile(c.path, patterns)) return [];
    if (c.status === 'D') return [`deleted: ${c.path}`];
    if (c.status === 'R' && c.to !== null && !isTestFile(c.to, patterns))
      return [`moved out of the test files: ${c.path} → ${c.to}`];

    return [];
  });

/** A line the diff adds: its file and line number in the new version. */
export type AddedLine = { file: string; line: number; text: string };

const unquote = (path: string) =>
  path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1).replace(/\\(["\\])/g, '$1') : path;

/** The new file's path from a `+++ b/<path>` header; null for `/dev/null`. */
const newPath = (header: string): string | null => {
  // git ends a path with a space in it with a tab.
  const path = unquote(header.slice('+++ '.length).replace(/\t$/, ''));

  if (path === '/dev/null') return null;

  return path.replace(/^"?b\//, '');
};

/**
 * The lines a unified diff (`git diff`) adds, read hunk by hunk by their counts, so an added line
 * that starts with `++` is never taken for a file header.
 */
export const addedLines = (patch: string): AddedLine[] => {
  const lines = patch.split('\n');
  const added: AddedLine[] = [];
  let file: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    if (line.startsWith('+++ ')) {
      file = newPath(line);
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);

    if (hunk === null) continue;
    let old = Number(hunk[1] ?? '1');
    let next = Number(hunk[3] ?? '1');
    let at = Number(hunk[2]);

    while ((old > 0 || next > 0) && i + 1 < lines.length) {
      i += 1;
      const body = lines[i] ?? '';

      if (body.startsWith('\\')) continue;
      if (body.startsWith('+')) {
        if (file !== null) added.push({ file, line: at, text: body.slice(1) });
        at += 1;
        next -= 1;
      } else if (body.startsWith('-')) old -= 1;
      else {
        at += 1;
        old -= 1;
        next -= 1;
      }
    }
  }

  return added;
};

/** What turns a check off for a line or a test, as written in a source file. */
export const SUPPRESSIONS = [
  '@ts-ignore',
  '@ts-expect-error',
  'eslint-disable',
  'biome-ignore',
  '# noqa',
  '.only(',
  '.skip(',
] as const;

export type Suppression = AddedLine & { marker: string };

/** The added lines that carry a suppression, each with the first one it carries. */
export const addedSuppressions = (lines: readonly AddedLine[]): Suppression[] =>
  lines.flatMap((l) => {
    const marker = SUPPRESSIONS.find((m) => l.text.includes(m));

    return marker === undefined ? [] : [{ ...l, marker }];
  });

/** The diff against the merge base as the git port read it, or why it could not be. */
export type BaseDiff =
  | { ok: true; base: string; mergeBase: string; nameStatus: string; patch: string }
  | { ok: false; message: string };

/** A check's result; `not-configured`: no Layer gives it a command, so it ran nothing. */
export const CHECK_STATUSES = ['green', 'red', 'not-configured'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** What a built-in check found on the diff. */
export const builtInCheck = (
  name: BuiltInCheck,
  diff: BaseDiff,
  testFiles: readonly string[],
): { status: CheckStatus; output: string } => {
  if (!diff.ok) return { status: 'red', output: `no diff against the merge base: ${diff.message}` };
  const found =
    name === 'no-deleted-tests'
      ? deletedTests(parseNameStatus(diff.nameStatus), testFiles)
      : addedSuppressions(addedLines(diff.patch)).map(
          (s) => `${s.file}:${s.line}: ${s.marker}: ${s.text.trim()}`,
        );
  const against = `against the merge base ${diff.mergeBase.slice(0, 12)} with ${diff.base}`;

  if (found.length === 0)
    return {
      status: 'green',
      output:
        name === 'no-deleted-tests'
          ? `no test file deleted ${against}\n`
          : `no suppression added ${against}\n`,
    };

  return {
    status: 'red',
    output: `${
      name === 'no-deleted-tests' ? `test files gone ${against}:` : `suppressions added ${against}:`
    }\n${found.join('\n')}\n`,
  };
};

export const CheckResult = z.object({
  name: z.string(),
  kind: z.enum(['command', 'built-in']),
  /** The command run; null for a built-in, or a check no Layer gave a command. */
  run: z.string().nullable(),
  status: z.enum(CHECK_STATUSES),
  /** The command's exit code; null when killed (its time ran out), not configured, or built in. */
  exit: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  /** What it printed (stdout and stderr together), the tail when long. */
  output: z.string(),
});
export type CheckResult = z.infer<typeof CheckResult>;

/** Why checks ran: the run entered `checks` (or still was, at a restart), or `abe factory checks`. */
export const CHECKS_CAUSES = ['checks', 'on-demand'] as const;
export type ChecksCause = (typeof CHECKS_CAUSES)[number];

/** One run of a card's checks, as `abe factory checks` prints it. */
export const FactoryChecksData = z.object({
  card: z.number().int().positive(),
  session: z.string(),
  worktree: z.string(),
  green: z.boolean(),
  cause: z.enum(CHECKS_CAUSES),
  /** No check with a command ran (none configured): nothing was run, so not green (#159). */
  none: z.boolean().default(false),
  /** The checks.md written. */
  file: z.string(),
  /**
   * What to know about `checks` / `testFiles` in this checkout: an entry refused for want of an
   * Override, and an Override in force (`checks overridden by repo: <reason>`).
   */
  settings: z.array(z.string()),
  results: z.array(CheckResult),
});
export type FactoryChecksData = z.infer<typeof FactoryChecksData>;

/**
 * What a run of checks says: `red` when any is red; `none` when no check with a command ran (the
 * built-ins alone run nothing of the code: no test, typecheck or lint); else `green`. A check
 * with no command is not configured: it neither passes nor fails.
 */
export type ChecksVerdict = 'green' | 'red' | 'none';

export const checksVerdict = (
  results: readonly Pick<CheckResult, 'kind' | 'status'>[],
): ChecksVerdict => {
  if (results.some((r) => r.status === 'red')) return 'red';

  return results.some((r) => r.kind === 'command' && r.status === 'green') ? 'green' : 'none';
};

/** All green: none red, and at least one check with a command ran. */
export const checksGreen = (results: readonly Pick<CheckResult, 'kind' | 'status'>[]): boolean =>
  checksVerdict(results) === 'green';

/** The words for checks that ran nothing: in their text, checks.md and the run's status. */
export const NO_CHECKS = 'no checks configured: nothing was run';

/** Whether the checks in force run any command: a repo with no pack has none (#159). */
export const checksConfigured = (entries: readonly CheckEntry[]): boolean =>
  checksPlan(entries).some((s) => s.kind === 'command');

/** The checks named with no command in force, in order: they are not run. */
export const unconfiguredChecks = (entries: readonly CheckEntry[]): string[] =>
  checksPlan(entries).flatMap((s) => (s.kind === 'no-run' ? [s.name] : []));

/** What checks that ran nothing tell the person, in checks.md. */
export const NO_CHECKS_HELP =
  "No check in force has a command, so no test, typecheck or lint ran. Give them one in the repo's abe.yaml (`abe settings check .` shows a minimal one). The run goes on, its pull request's Verified line says nothing was run, and a person merges it.";

/** The checks a repo pack gives a command, and the `package.json` scripts each is suggested from. */
const EXAMPLE_SCRIPTS: readonly (readonly [string, readonly string[]])[] = [
  ['tests', ['test']],
  ['types', ['typecheck', 'type-check', 'types', 'tsc']],
  ['lint', ['lint']],
];

/**
 * A minimal repo pack's `checks` (`abe.yaml`): tests, types and lint, each run by the
 * `package.json` script there is for it (`npm test`, `npm run typecheck`), else a placeholder.
 */
export const checksExample = (scripts: Readonly<Record<string, unknown>> = {}): string =>
  [
    'checks:',
    ...EXAMPLE_SCRIPTS.flatMap(([name, names]) => {
      const script = names.find((n) => typeof scripts[n] === 'string');
      const npm = script === 'test' ? 'npm test' : `npm run ${script ?? ''}`;
      const run = script === undefined ? `<the command that runs your ${name}>` : npm;

      return [`  - name: ${name}`, `    run: ${run}`];
    }),
    '',
  ].join('\n');

/** A check that is not configured, as its result says it. */
export const notConfiguredOutput = (name: string): string =>
  `not configured: no Layer gives ${name} a command, so it was not run\n`;

const verdictOf = (d: Pick<FactoryChecksData, 'green' | 'none'>): ChecksVerdict => {
  if (d.green) return 'green';

  return d.none ? 'none' : 'red';
};

const verdictWords = (d: Pick<FactoryChecksData, 'green' | 'none'>) =>
  ({ green: 'green', red: 'red', none: NO_CHECKS })[verdictOf(d)];

/** How checks.md starts, by the verdict. */
const HEADS: Readonly<Record<ChecksVerdict, string>> = {
  green: 'Green',
  red: 'Red',
  none: 'No checks configured, nothing was run,',
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

const resultWords = (r: CheckResult) => {
  if (r.status === 'not-configured') return 'not configured';
  if (r.kind === 'built-in') return r.status;

  return `${r.status} (${r.exit === null ? 'killed' : `exit ${r.exit}`}, ${seconds(r.durationMs)})`;
};

export const factoryChecksText = (d: FactoryChecksData): string =>
  [
    `AB#${d.card} checks ${verdictWords(d)}  ${d.file}`,
    ...d.settings.map((p) => `  settings: ${p}`),
    ...d.results.map((r) => `  ${r.name.padEnd(20)}  ${resultWords(r)}`),
    '',
  ].join('\n');

/** A fence longer than any run of backticks in `text`, so the output cannot close it. */
const fence = (text: string) => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));

  return '`'.repeat(Math.max(3, longest + 1));
};

const block = (text: string) => {
  const f = fence(text);

  return `${f}text\n${text.endsWith('\n') || text === '' ? text : `${text}\n`}${f}`;
};

/** `.scratch/<card>/checks.md`: every result with its output, the Evidence a run's checks leave. */
export const checksMarkdown = (d: FactoryChecksData, at: string): string =>
  [
    `# Checks · AB#${d.card}`,
    '',
    `${HEADS[verdictOf(d)]} at ${at} (${d.cause === 'checks' ? 'after build' : 'on demand'}), in ${d.worktree}.`,
    ...(d.none ? ['', NO_CHECKS_HELP] : []),
    ...(d.settings.length === 0 ? [] : ['', '## Settings', '', ...d.settings.map((p) => `- ${p}`)]),
    ...d.results.flatMap((r) => [
      '',
      `## ${r.name} · ${resultWords(r)}`,
      '',
      ...(r.run === null ? [] : [`\`${r.run}\``, '']),
      block(r.output),
    ]),
    '',
  ].join('\n');

/** The last `lines` lines of `text`, and at most `chars` characters of them. */
export const tail = (text: string, lines: number, chars: number): string => {
  const kept = text.trimEnd().split('\n').slice(-lines).join('\n');

  return kept.length <= chars ? kept : `…${kept.slice(-chars)}`;
};

/**
 * What a check's command ran with, by name only (never a value): the Abe environment whose env
 * file was put over the checks' own (`dev`), and the variables it was given.
 */
export const ChecksEnv = z.object({
  /** The Abe env file's environment (`dev`, `test`); null: none was put over. */
  name: z.string().nullable(),
  /** The variables' names, sorted (`CI`, `DATABASE_URL`, `HOME`). */
  keys: z.array(z.string()),
});
export type ChecksEnv = z.infer<typeof ChecksEnv>;

/** A check's output kept on the run: its last lines only (checks.md has it whole). */
export const KEPT_OUTPUT_LINES = 12;
export const KEPT_OUTPUT_CHARS = 2000;

/**
 * One run of a card's checks as the run keeps it (`Run.checks`): when, why, the verdict, the env
 * it ran with, the file written, each result with its output's tail.
 */
export const ChecksKept = z.object({
  at: z.iso.datetime(),
  cause: z.enum(CHECKS_CAUSES),
  verdict: z.enum(['green', 'red', 'none']),
  env: ChecksEnv.nullable().default(null),
  /** The checks.md written, relative to the worktree. */
  file: z.string(),
  results: z.array(CheckResult),
});
export type ChecksKept = z.infer<typeof ChecksKept>;

/** A run of checks as the run keeps it: each output cut to its tail. */
export const checksKept = (
  d: FactoryChecksData,
  at: string,
  env: ChecksEnv | null,
): ChecksKept => ({
  at,
  cause: d.cause,
  verdict: checksVerdict(d.results),
  env,
  file: checksFile(d.card),
  results: d.results.map((r) => ({
    ...r,
    output: tail(r.output, KEPT_OUTPUT_LINES, KEPT_OUTPUT_CHARS),
  })),
});

/** What is typed into the session when checks are red: what failed and the end of its output. */
export const checksSaid = (d: FactoryChecksData): string => {
  const red = d.results.filter((r) => r.status === 'red');

  return [
    `Checks failed, so the run is back in build: ${red.map((r) => r.name).join(', ')}. Fix what they say, then run abe factory stage-done build again. All of it is in ${checksFile(d.card)}.`,
    ...red.flatMap((r) => [
      '',
      `## ${r.name}${r.run === null ? '' : ` (${r.run})`}: ${r.exit === null ? 'red' : `exit ${r.exit}`}`,
      tail(r.output, 60, 4000),
    ]),
  ].join('\n');
};

/** What is typed into the session when its checks could not run at all. */
export const checksNotRun = (why: string): string =>
  `Checks could not run, so the run is back in build: ${why}. Fix that, then run abe factory stage-done build again.`;

/** The `factory.checks` event: each result of a run of a card's checks, without the output. */
export const FactoryChecksEvent = z.object({
  card: z.number().int().positive(),
  session: z.string(),
  green: z.boolean(),
  cause: z.enum(CHECKS_CAUSES),
  none: z.boolean().default(false),
  file: z.string(),
  results: z.array(CheckResult.pick({ name: true, status: true, exit: true, durationMs: true })),
});
export type FactoryChecksEvent = z.infer<typeof FactoryChecksEvent>;

export const checksEvent = (d: FactoryChecksData): FactoryChecksEvent => ({
  card: d.card,
  session: d.session,
  green: d.green,
  cause: d.cause,
  none: d.none,
  file: d.file,
  results: d.results.map((r) => ({
    name: r.name,
    status: r.status,
    exit: r.exit,
    durationMs: r.durationMs,
  })),
});

export const factoryChecksEventText = (d: FactoryChecksEvent): string =>
  `AB#${d.card} checks ${verdictWords(d)}: ${d.results.map((r) => `${r.name} ${r.status}`).join(', ')} (${d.cause})`;
