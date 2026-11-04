/**
 * The `checks` setting (ticket #46): the deterministic checks a Factory run's build must pass
 * before review. An entry is a check's name, or `{ name, run }`: the shell command that runs it in
 * the worktree (a repo pack's `tests`, `types`, `lint`). Two names are built in and take no
 * command: `no-deleted-tests` and `no-new-suppressions`.
 *
 * Down the Layers a plain entry adds a check by its name, or gives a check named above its
 * command. Changing a command given above removes that check as written, so below the org it
 * takes an Override, as dropping one does (an Override's list replaces the whole value).
 */
import { z } from 'zod';

/** The checks `serve` itself runs on the diff against the merge base, after the commands. */
export const BUILT_IN_CHECKS = ['no-deleted-tests', 'no-new-suppressions'] as const;
export type BuiltInCheck = (typeof BUILT_IN_CHECKS)[number];

export const isBuiltInCheck = (name: string): name is BuiltInCheck =>
  BUILT_IN_CHECKS.some((b) => b === name);

const checkName = z.string().regex(/^[A-Za-z0-9][\w.-]*$/, 'a check name: letters, digits, . _ -');

export const CheckEntryValue = z.union([
  checkName,
  z
    .strictObject({ name: checkName, run: z.string().trim().min(1).optional() })
    .refine((e) => e.run === undefined || !isBuiltInCheck(e.name), {
      message: 'a built-in check takes no run',
    }),
]);
export type CheckEntryValue = z.infer<typeof CheckEntryValue>;

/** One check as it runs: its name and its command (null: built in, or none given yet). */
export type CheckEntry = { name: string; run: string | null };

export const checkEntry = (e: CheckEntryValue): CheckEntry =>
  typeof e === 'string' ? { name: e, run: null } : { name: e.name, run: e.run ?? null };

/** The merged value as the checks it names, in order. */
export const checkEntries = (value: readonly CheckEntryValue[]): CheckEntry[] =>
  value.map(checkEntry);

const nameOf = (e: CheckEntryValue) => checkEntry(e).name;
const runOf = (e: CheckEntryValue) => checkEntry(e).run;

/**
 * A plain entry below: a new name is added at the end; a name already there takes the entry's
 * command when it gives one (no command keeps the one above).
 */
export const addChecks = (
  above: readonly CheckEntryValue[],
  written: readonly CheckEntryValue[],
): CheckEntryValue[] => {
  const out = [...above];

  for (const w of written) {
    const i = out.findIndex((e) => nameOf(e) === nameOf(w));

    if (i === -1) out.push(w);
    else if (runOf(w) !== null) out[i] = w;
  }

  return out;
};

/**
 * Why `next` needs an Override over `above`: a check's command given above changed (a plain entry
 * never drops a check; only an Override's list does).
 */
export const loweredChecks = (
  above: readonly CheckEntryValue[],
  next: readonly CheckEntryValue[],
): string | undefined => {
  const changed = above.filter((a) => {
    const n = next.find((e) => nameOf(e) === nameOf(a));

    return runOf(a) !== null && n !== undefined && runOf(n) !== runOf(a);
  });

  return changed.length === 0
    ? undefined
    : `changes the command of the check ${changed.map(nameOf).join(', ')} above`;
};

/**
 * Whether an Override's list `written` cuts the checks above (#168): a check above it drops, or a
 * command given above it changes. Adding checks or giving a command where there was none cuts none.
 */
export const cutChecks = (
  above: readonly CheckEntryValue[],
  written: readonly CheckEntryValue[],
): string | undefined => {
  const dropped = above.filter((a) => !written.some((w) => nameOf(w) === nameOf(a)));

  return dropped.length === 0
    ? loweredChecks(above, written)
    : `drops the check ${dropped.map(nameOf).join(', ')}`;
};
