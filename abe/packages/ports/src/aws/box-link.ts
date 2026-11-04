/**
 * How the Mac's `serve` runs `abe` on a box: a command that runs `abe <argv>` there. By default
 * SSH through the box's EC2 Instance Connect Endpoint (`eiceLink`, `eice-link.ts`; ADR 0021, #91).
 * `$ABE_BOX_LINK` names another: `exec:<path>`, an ssh-like command (`<path> [-t] <box> -- abe …`);
 * `docker:<container>`, `docker exec` into the stand-in box on this Mac's Docker
 * (`abe/images/fake-box`); `socket:<path>`, this machine's `abe` on that socket; `ssm`, the box's
 * `abe` through SSM Run Command (`run` only). IO only.
 */
import { type Answered, type Boxes, type BoxLink, type Ran, shellWord } from '@abe/core';
import { z } from 'zod';
import { type AwsCli } from './aws';
import { eiceLinkFrom } from './eice-link';
import { type Env } from '../mac/locations';

/**
 * How long one `abe` on a box may run: `workspace up` builds an image on a first start, and
 * `session run` may run the repo's setup for up to 15 minutes before claude starts.
 */
const RUN_TIMEOUT_MS = 30 * 60_000;

export type CommandLinkOptions = {
  /** The argv that runs `abe` on `box` (`… abe`); `tty` when a person's terminal is handed to it. */
  abe: (box: string, tty: boolean) => string[];
  /** Flags after every command (`--no-start`). */
  after?: readonly string[];
  /**
   * The words after `abe(box)` go through a remote shell (`ssh` joins its argv with spaces and
   * the box's shell splits them again): each is quoted, so a card's text stays one word and
   * nothing in it runs.
   */
  quoted?: boolean;
  env: Env;
  timeoutMs?: number;
};

const envOf = (env: Env) =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));

export const commandLink = (o: CommandLinkOptions): BoxLink => {
  const env = envOf(o.env);
  const after = o.after ?? [];
  const words = (argv: readonly string[]) => {
    const all = [...argv, ...after];

    return o.quoted === true ? all.map(shellWord) : all;
  };

  return {
    run: async (box, argv) => {
      let child;

      try {
        child = Bun.spawn([...o.abe(box, false), ...words(argv)], {
          env,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        });
      } catch (err) {
        // The link's own command is missing: the box cannot be reached, said as ssh would.
        const why = err instanceof Error ? err.message : String(err);

        return { exit: 255, stdout: '', stderr: `${why}\n` } satisfies Ran;
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, o.timeoutMs ?? RUN_TIMEOUT_MS);
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).finally(() => {
        clearTimeout(timer);
      });

      return { exit, stdout, stderr } satisfies Ran;
    },
    follow: (box, argv, onLine) => {
      let child;

      try {
        child = Bun.spawn([...o.abe(box, false), ...words(argv)], {
          env,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'ignore',
        });
      } catch {
        // The link's own command is missing: a stream that ends at once, as a dropped one.
        return { stop: () => undefined, ended: Promise.resolve(255) };
      }
      const ended = (async () => {
        const decoder = new TextDecoder();
        let held = '';

        for await (const chunk of child.stdout) {
          held += decoder.decode(chunk, { stream: true });
          for (let nl = held.indexOf('\n'); nl >= 0; nl = held.indexOf('\n')) {
            const line = held.slice(0, nl);

            held = held.slice(nl + 1);
            if (line.trim() !== '') onLine(line);
          }
        }

        return child.exited;
      })();

      return {
        stop: () => {
          child.kill();
        },
        ended,
      };
    },
    attach: (box, argv) => [...o.abe(box, true), ...words(argv)],
    // Only the EC2 Instance Connect link forwards ports (`eiceLink`).
    forward: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'forward-unsupported', message: 'this box link forwards no ports' },
      }),
  };
};

/**
 * An ssh-like command (`exec:<path>`): `<path> [-t] <box> -- abe <words>`, the words quoted for
 * the box's shell. Tests' fake box shell is one; so is a wrapper around `ssh`.
 */
export const execLink = (env: Env, command: string): BoxLink =>
  commandLink({
    env,
    abe: (box, tty) => [command, ...(tty ? ['-t'] : []), box, '--', 'abe'],
    quoted: true,
  });

/** Into the stand-in box on this Mac's Docker: every box name is that one container. */
export const dockerLink = (env: Env, container: string, docker = 'docker'): BoxLink =>
  commandLink({
    env,
    abe: (_box, tty) => [docker, 'exec', ...(tty ? ['-it'] : []), container, 'abe'],
  });

/**
 * A box's `serve` reached on its socket from this machine (`socket:<path>`): the same `abe`
 * (`self`) with `ABE_SOCKET` set, never starting a `serve`. Tests run a box's `serve` this way.
 */
export const socketLink = (env: Env, socket: string, self: readonly string[]): BoxLink =>
  commandLink({
    env,
    abe: () => ['/usr/bin/env', `ABE_SOCKET=${socket}`, ...self],
    after: ['--no-start'],
  });

const SsmSent = z.looseObject({ Command: z.looseObject({ CommandId: z.string() }) });
const SsmResult = z.looseObject({
  Status: z.string(),
  ResponseCode: z.number(),
  StandardOutputContent: z.string(),
  StandardErrorContent: z.string(),
});

/** How long an SSM command is waited for, and how often it is looked at. */
const SSM_TIMEOUT_MS = 30 * 60_000;
const SSM_POLL_MS = 500;
/**
 * SSM Run Command hands back only the first 24,000 characters a command printed (`aws ssm
 * get-command-invocation`'s `StandardOutputContent` / `StandardErrorContent`): a screenshot read
 * through it as base64 came back a PNG black below its first rows (#66).
 */
export const SSM_OUTPUT_LIMIT = 24_000;
const cutNote = (what: string) =>
  `ssm: ${what} cut at SSM Run Command's 24,000 characters; read it through SSH (abe box attach) instead\n`;

/**
 * The box's `abe` through SSM Run Command (`ssm`; the person's SSO may send commands to the box):
 * `run` only, as `ubuntu` with `ABE_BOX=1`. It has no stream (`follow` hears nothing until
 * stopped), no terminal (`attach` says so) and no ports: a fallback for `abe --on` and the checks
 * where SSH is not open. Output past SSM's 24,000 characters is cut: an output at that length is
 * said so on stderr (`SSM_OUTPUT_LIMIT`), its exit kept.
 */
export const ssmLink = (o: {
  aws: AwsCli;
  boxes: Boxes;
  /** `--region`, as the `Boxes` port's (null: the CLI's own). */
  region?: string | null;
  sleep?: (ms: number) => Promise<void>;
}): BoxLink => {
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const where = o.region === undefined || o.region === null ? [] : ['--region', o.region];
  const unreachable = (why: string): Ran => ({ exit: 255, stdout: '', stderr: `ssm: ${why}\n` });
  const json = <T extends z.ZodType>(schema: T, a: Answered<string>): z.output<T> | string => {
    if (!a.ok) return a.error.message;
    try {
      const read = schema.safeParse(JSON.parse(a.data));

      return read.success ? read.data : 'aws ssm answered a shape Abe does not read';
    } catch {
      return 'aws ssm answered no JSON';
    }
  };

  return {
    run: async (box, argv) => {
      const found = await o.boxes.status(box);

      if (!found.ok) return unreachable(found.error.message);
      if (found.data?.state !== 'running')
        return unreachable(`box ${box} is ${found.data?.state ?? 'not yours'}`);
      const id = found.data.id;
      const line = `sudo -u ubuntu -H env ABE_BOX=1 /usr/local/bin/abe ${argv.map(shellWord).join(' ')}`;
      const sent = json(
        SsmSent,
        await o.aws([
          'ssm',
          'send-command',
          '--instance-ids',
          id,
          '--document-name',
          'AWS-RunShellScript',
          '--parameters',
          JSON.stringify({ commands: [line], executionTimeout: ['1800'] }),
          ...where,
          '--output',
          'json',
        ]),
      );

      if (typeof sent === 'string') return unreachable(sent);
      const until = Date.now() + SSM_TIMEOUT_MS;

      for (;;) {
        await sleep(SSM_POLL_MS);
        const got = json(
          SsmResult,
          await o.aws([
            'ssm',
            'get-command-invocation',
            '--command-id',
            sent.Command.CommandId,
            '--instance-id',
            id,
            ...where,
            '--output',
            'json',
          ]),
        );

        // Just sent: SSM may not know the invocation yet.
        if (typeof got === 'string') {
          if (Date.now() > until) return unreachable(got);
          continue;
        }
        if (['Pending', 'InProgress', 'Delayed'].includes(got.Status) && Date.now() <= until)
          continue;

        const cut = [
          ...(got.StandardOutputContent.length >= SSM_OUTPUT_LIMIT ? [cutNote('the output')] : []),
          ...(got.StandardErrorContent.length >= SSM_OUTPUT_LIMIT ? [cutNote('the errors')] : []),
        ].join('');

        return {
          exit: got.ResponseCode < 0 ? 255 : got.ResponseCode,
          stdout: got.StandardOutputContent,
          stderr: got.StandardErrorContent + cut,
        };
      }
    },
    follow: () => {
      let stop = () => undefined;
      const ended = new Promise<number>((resolve) => {
        stop = () => {
          resolve(0);
        };
      });

      return { stop, ended };
    },
    attach: (box) => [
      '/bin/sh',
      '-c',
      `echo "abe: no terminal on box ${box} through SSM (abe box attach is SSH's)" >&2; exit 3`,
    ],
    forward: () =>
      Promise.resolve({
        ok: false,
        error: { code: 'forward-unsupported', message: 'SSM forwards no ports' },
      }),
  };
};

/**
 * The link `$ABE_BOX_LINK` names (`exec:`, `docker:`, `socket:`, `ssm`: SSM Run Command through
 * the person's AWS login, `boxes` finding the box's instance), else SSH through the EC2 Instance
 * Connect Endpoint.
 */
export const boxLinkFrom = (
  env: Env,
  self: readonly string[],
  ssm: { aws: AwsCli; boxes: Boxes; region?: string | null },
): BoxLink => {
  const named = env.ABE_BOX_LINK ?? '';

  if (named.startsWith('exec:')) return execLink(env, named.slice('exec:'.length));
  if (named.startsWith('docker:')) return dockerLink(env, named.slice('docker:'.length));
  if (named.startsWith('socket:')) return socketLink(env, named.slice('socket:'.length), self);
  if (named === 'ssm') return ssmLink(ssm);

  return eiceLinkFrom(env, self, ssm.boxes);
};
