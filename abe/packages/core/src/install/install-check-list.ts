/**
 * Factory install: the one list of the repo's checks is `abe.yaml`'s `checks:`. The
 * written files (`CLAUDE.md`, the verify and testing skills) name a check only from it. A check
 * the repo has (a package script, a CI command) that the list leaves out, because it fails here or
 * is not wanted, is said as "not a check yet: <why>", never as one. Pure: texts in, findings out.
 */

import { type CheckProof, checkKey } from './install-check';

/** A check as `checks:` lists it: its name and the command it runs. */
export type ListedCheck = { name: string; run: string };

/** A written file's mention of a check the list does not have. */
export type UnlistedCheck = { file: string; command: string };

/** The package scripts a check is, by their whole name (`lint:fix` is not one). */
const CHECK_SCRIPTS = [
  'test',
  'lint',
  'prettier',
  'format',
  'typecheck',
  'types',
  'tsc',
  'syncpack',
  'check',
];

/** A CI command that checks a change (`npm ci` and a build do not). */
const CHECKING_CI = /\b(?:test|lint|prettier|format|typecheck|tsc|syncpack|vitest|jest|eslint)\b/;

/** The phrase that says a command is left out of the list, and why. */
const NOT_A_CHECK = /not a check/i;

/** How the package managers run script `name`. */
const scriptForm = (name: string): RegExp =>
  new RegExp(`\\b(?:npm|pnpm|yarn|bun)(?: run)?\\s+${name}(?![\\w:-])`);

/**
 * The checks `files` (path → text) name that `listed` does not: each file and the command, the
 * repo's package `scripts` and `ci` commands being what a check can be. A line that says "not a
 * check" is the way to name one that is left out.
 */
export const unlistedChecks = (o: {
  listed: readonly ListedCheck[];
  scripts: Readonly<Record<string, string>>;
  ci: readonly string[];
  files: ReadonlyMap<string, string>;
}): UnlistedCheck[] => {
  const has = (run: string, ci: string) => run.includes(ci) || ci.includes(run);
  const forms = CHECK_SCRIPTS.filter((n) => o.scripts[n] !== undefined)
    .map(scriptForm)
    .filter((re) => !o.listed.some((l) => re.test(l.run)));
  const lines = [...new Set(o.ci.map((c) => c.trim()))].filter(
    (c) => c !== '' && CHECKING_CI.test(c) && !o.listed.some((l) => has(l.run, c)),
  );
  const out: UnlistedCheck[] = [];

  for (const [file, text] of o.files)
    for (const line of text.split('\n')) {
      if (NOT_A_CHECK.test(line)) continue;
      const named = [
        ...forms.flatMap((re) => re.exec(line)?.[0] ?? []),
        ...lines.filter((c) => line.includes(c)),
      ];

      for (const command of named)
        if (!out.some((u) => u.file === file && u.command === command)) out.push({ file, command });
    }

  return out;
};

/** Why a check the repo has is not one yet, from what Checks saw of it (`runs`, by `checkKey`). */
const notYetWhy = (command: string, runs: Readonly<Record<string, CheckProof>>): string => {
  const ran = runs[checkKey(command)];

  if (ran === undefined) return 'not tried at Checks';

  return ran.ok
    ? "it passed at Checks, but abe.yaml's checks: does not list it"
    : `it failed when serve ran it at Checks, exit ${ran.exit ?? 'none'}`;
};

/**
 * The lines the install's check says for the checks the files name that the list leaves out, each
 * once: "Not a check yet: `<command>` (<why>)". A note, never a refusal, and no file is written.
 */
export const notACheckLines = (
  unlisted: readonly UnlistedCheck[],
  runs: Readonly<Record<string, CheckProof>>,
): string[] =>
  [...new Set(unlisted.map((u) => u.command))].map(
    (c) => `Not a check yet: \`${c}\` (${notYetWhy(c, runs)})`,
  );
