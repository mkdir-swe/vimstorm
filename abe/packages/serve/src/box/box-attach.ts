/**
 * `abe box attach` and `abe box forward` in the client (#91): the EC2 Instance Connect link from
 * this environment, the attach loop on this terminal, a forward kept up until Ctrl-C.
 */
import {
  type BoxForwardData,
  COMMANDS,
  EXIT,
  type Handlers,
  printFailure,
  refused,
  textOf,
} from '@abe/core';
import { attachLoop, type AttachWhat, ec2BoxesFrom, eiceLinkFrom, type Env } from '@abe/ports';
import { startBox } from './box-settle';
import { BOX_BOOT_MS, BOX_POLL_MS } from './boxes';

type Io = { write: (stdout: string, stderr: string) => void };

/** Aborted on SIGINT, SIGTERM or SIGHUP, which then no longer end the process by themselves. */
const leaving = (): AbortSignal => {
  const ac = new AbortController();

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.on(signal, () => {
      ac.abort();
    });

  return ac.signal;
};

export const runBoxAttach = async (
  box: string,
  what: AttachWhat,
  env: Env,
  self: readonly string[],
  io: Io,
): Promise<number> => {
  const boxes = ec2BoxesFrom(env);
  const link = eiceLinkFrom(env, self, boxes);

  try {
    return await attachLoop({
      link,
      box,
      what,
      tty: process.stdin.isTTY,
      sleep: (ms) => Bun.sleep(ms),
      now: () => Date.now(),
      say: (line) => {
        io.write('', `${line}\n`);
      },
      // As serve wakes one: started (a stop in progress first), then waited for until it runs.
      wake: async (b) => {
        const up = await startBox(
          { boxes, now: () => Date.now(), sleep: (ms) => Bun.sleep(ms), pollMs: BOX_POLL_MS },
          b,
          Date.now() + BOX_BOOT_MS,
        );

        return up.ok ? { ok: true, data: null } : up;
      },
      leaving: leaving(),
    });
  } finally {
    link.close();
  }
};

export const runBoxForward = async (
  box: string,
  port: number,
  json: boolean,
  env: Env,
  self: readonly string[],
  io: Io,
): Promise<number> => {
  // Before anything starts: a Ctrl-C while it comes up still stops ssh and removes the keys.
  const left = leaving();
  const link = eiceLinkFrom(env, self);
  const failed = (message: string) => {
    const out = printFailure({ code: 'forward-failed', message }, EXIT.failed, json);

    io.write(out.stdout, out.stderr);

    return out.exit;
  };

  try {
    // Its tunnel takes seconds (#193): said at once, on stderr, so stdout stays the answer.
    if (!json)
      io.write('', `${box}: opening a tunnel to its port ${port} (EC2 Instance Connect)…\n`);
    const up = await link.forward(box, port);

    if (!up.ok) {
      const out = printFailure(up.error, EXIT.failed, json);

      io.write(out.stdout, out.stderr);

      return out.exit;
    }
    if (left.aborted) {
      up.data.stop();

      return EXIT.ok;
    }
    const data: BoxForwardData = { box, port, local: up.data.port };

    io.write(
      json ? `${JSON.stringify({ ok: true, data })}\n` : textOf(COMMANDS['box forward'], data),
      '',
    );
    const stopped = new Promise<''>((resolve) => {
      left.addEventListener('abort', () => {
        resolve('');
      });
    });
    const why = await Promise.race([stopped, up.data.ended]);

    up.data.stop();

    return why === '' ? EXIT.ok : failed(why);
  } finally {
    link.close();
  }
};

/** Serve's answer to a command only the `abe` client runs. */
export const clientOnly = (command: string) =>
  Promise.resolve(refused('client-only', `abe ${command} is run by the abe client, not serve`));

/** The box commands the `abe` client runs itself, refused by serve. */
export const clientHandlers = {
  // the terminal's and its ports' own, run by the client (`runBoxAttach`, `runBoxForward`)
  'box attach': () => clientOnly('box attach'),
  'box forward': () => clientOnly('box forward'),
  // in a box's workspace, once per connection of its box's relay: `main.ts` runs it without `app.ts`
  'port pipe': () => clientOnly('port pipe'),
} satisfies Partial<Handlers<unknown>>;
