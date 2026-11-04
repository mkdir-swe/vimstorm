/**
 * A fake port whose calls wait for the test. Each call stays open until `resolve` or `fail`
 * answers the oldest one equal to it. `settled()` fails a test that left a call unanswered.
 */
import { deepEquals } from 'bun';

export type Held<I, O> = {
  /** What the code under test calls in place of the real adapter. */
  call: (input: I) => Promise<O>;
  /** Answers the oldest open call with this input. */
  resolve: (input: I, value: O) => void;
  fail: (input: I, error: Error) => void;
  /** The inputs not answered yet, oldest first. */
  open: () => I[];
  /** Throws when a call is still open. */
  settled: () => void;
};

export const held = <I, O>(name: string): Held<I, O> => {
  let calls: { input: I; resolve: (value: O) => void; reject: (error: Error) => void }[] = [];

  const take = (input: I) => {
    const found = calls.find((c) => deepEquals(c.input, input));

    if (found === undefined)
      throw new Error(
        `No open ${name}(${JSON.stringify(input)}); open: ${calls.map((c) => JSON.stringify(c.input)).join(', ') || 'none'}`,
      );
    calls = calls.filter((c) => c !== found);

    return found;
  };

  return {
    call: (input) =>
      new Promise<O>((resolve, reject) => {
        calls.push({ input, resolve, reject });
      }),
    resolve: (input, value) => {
      take(input).resolve(value);
    },
    fail: (input, error) => {
      take(input).reject(error);
    },
    open: () => calls.map((c) => c.input),
    settled: () => {
      if (calls.length > 0)
        throw new Error(
          `${name} left open: ${calls.map((c) => JSON.stringify(c.input)).join(', ')}`,
        );
    },
  };
};
