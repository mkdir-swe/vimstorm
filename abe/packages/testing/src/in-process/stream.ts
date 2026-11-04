/** A process that keeps printing, like `abe watch`, read a line at a time while it runs. */

export type Streaming = {
  pid: number;
  /** The next stdout line, without its newline. Fails after `ms`. */
  next: (ms?: number) => Promise<string>;
  /** The next `n` lines. */
  lines: (n: number, ms?: number) => Promise<string[]>;
  signal: (signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGSTOP') => void;
  /** Its exit code, the stdout lines not read by `next`, and its stderr. */
  exited: Promise<{ exit: number; rest: string[]; stderr: string }>;
  /** Writes to its stdin, such as `abe ui bridge`'s frames. `end` closes it. */
  write: (text: string) => void;
  end: () => void;
};

const WAIT_MS = 5000;

export const streaming = (argv: readonly string[], env: Record<string, string>, cwd: string) => {
  const child = Bun.spawn([...argv], {
    env,
    cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const queue: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let ended = false;
  let partial = '';

  const deliver = (line: string | undefined) => {
    const waiter = waiting.shift();

    if (waiter === undefined) {
      if (line !== undefined) queue.push(line);
    } else waiter(line);
  };

  const read = (async () => {
    const decoder = new TextDecoder();

    for await (const chunk of child.stdout) {
      partial += decoder.decode(chunk, { stream: true });
      let nl = partial.indexOf('\n');

      while (nl >= 0) {
        deliver(partial.slice(0, nl));
        partial = partial.slice(nl + 1);
        nl = partial.indexOf('\n');
      }
    }
    ended = true;
    while (waiting.length > 0) deliver(undefined);
  })();

  const next = (ms = WAIT_MS) => {
    const ready = queue.shift();

    if (ready !== undefined) return Promise.resolve(ready);
    if (ended) return Promise.reject(new Error(`${argv.join(' ')} ended with no more lines`));

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = waiting.indexOf(take);

        if (at >= 0) waiting.splice(at, 1);
        reject(new Error(`no line from ${argv.join(' ')} within ${ms} ms`));
      }, ms);
      const take = (line: string | undefined) => {
        clearTimeout(timer);
        if (line === undefined) reject(new Error(`${argv.join(' ')} ended with no more lines`));
        else resolve(line);
      };

      waiting.push(take);
    });
  };

  const lines = async (n: number, ms = WAIT_MS) => {
    const got: string[] = [];

    for (let i = 0; i < n; i += 1) got.push(await next(ms));

    return got;
  };

  const exited = (async () => {
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    await read;

    return { exit, rest: queue.splice(0), stderr };
  })();

  const out: Streaming = {
    pid: child.pid,
    next,
    lines,
    signal: (signal) => {
      child.kill(signal);
    },
    exited,
    write: (text) => {
      void child.stdin.write(text);
      void child.stdin.flush();
    },
    end: () => {
      void child.stdin.end();
    },
  };

  return out;
};
