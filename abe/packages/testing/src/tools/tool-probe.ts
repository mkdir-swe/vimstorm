/** A fake `ToolProbe`. It answers each tool's check from a table and keeps every call. */
import { type FoundManager, type ToolProbe, type ToolRan } from '@abe/core';

export type FakeToolProbe = ToolProbe & {
  /** The argv of every check asked. */
  calls: string[][];
  /** Replaces one tool's answer, keyed by its command's name, like `node` or `docker`. */
  set: (bin: string, ran: Answer) => void;
};

/** One copy's check, or each copy's on PATH in order for `runEach`. `run` gets the first. */
type Answer = ToolRan | readonly ToolRan[];

const copies = (a: Answer | undefined): readonly ToolRan[] => {
  if (a === undefined) return [];

  return 'found' in a ? [a] : a;
};

/** Tools not in `answers` are not found, as on a bare PATH. `managers` are node's on this "Mac". */
export const fakeToolProbe = (
  answers: Readonly<Record<string, Answer>> = {},
  managers: readonly FoundManager[] = [],
): FakeToolProbe => {
  const table = new Map(Object.entries(answers));
  const calls: string[][] = [];

  return {
    calls,
    managers: () => Promise.resolve(managers),
    set: (bin, ran) => {
      table.set(bin, ran);
    },
    run: (argv) => {
      calls.push([...argv]);

      return Promise.resolve(copies(table.get(argv[0] ?? ''))[0] ?? { found: false });
    },
    runEach: (argv) => {
      calls.push([...argv]);

      return Promise.resolve(copies(table.get(argv[0] ?? '')).filter((r) => r.found));
    },
  };
};

/** A check that ran and printed `stdout`. `at` is where it was found. */
export const printed = (stdout: string, at?: string): ToolRan => ({
  found: true,
  ...(at === undefined ? {} : { at }),
  exit: 0,
  stdout,
  stderr: '',
});
