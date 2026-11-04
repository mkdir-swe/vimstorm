/**
 * Waits on something a test cannot be told about. Polls `check` until it gives a value other than
 * `undefined` and returns it. Fails after `ms` and names `what`. Pass a function as `what` for a
 * message that says what it last saw.
 */
export const until = async <T>(
  what: string | (() => string),
  check: () => Promise<T | undefined> | T | undefined,
  o: { ms?: number; every?: number } = {},
): Promise<T> => {
  const deadline = Date.now() + (o.ms ?? 10_000);

  for (;;) {
    const value = await check();

    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${typeof what === 'string' ? what : what()}`);
    await Bun.sleep(o.every ?? 50);
  }
};
