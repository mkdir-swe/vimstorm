/** Docker compose on the local machine through the `docker` CLI, with exactly the env it is given. IO only. */
import { type Compose, type Ran } from '@abe/core';

/** How long a project's `down` may take before it is killed. */
const DOWN_TIMEOUT_MS = 120_000;

/** How long a workspace's compose command may take on the box (an `up` that pulls images). */
const RUN_TIMEOUT_MS = 10 * 60_000;

const NO_DOCKER: Ran = { exit: 127, stdout: '', stderr: 'no docker here' };

const run = async (
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  ms: number,
  at: { cwd?: string; stdin?: string } = {},
) => {
  try {
    const child = Bun.spawn([...argv], {
      env: { ...env },
      ...(at.cwd === undefined ? {} : { cwd: at.cwd }),
      stdin: at.stdin === undefined ? 'ignore' : new TextEncoder().encode(at.stdin),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: ms,
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return { exit, stdout, stderr } satisfies Ran;
  } catch (err) {
    // no `docker` to run
    return { exit: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
};

/** `bin`: the `docker` to run (`findDocker`, `$ABE_DOCKER`); null: none here. */
export const dockerCompose = (o: { bin: string | null }): Compose => ({
  endpoint: async (env) => {
    if (o.bin === null) return null;
    const ran = await run(
      [o.bin, 'context', 'inspect', '--format', '{{.Name}}\t{{.Endpoints.docker.Host}}'],
      env,
      10_000,
    );
    const [name, host] = ran.stdout.trim().split('\t');

    return ran.exit !== 0 || name === undefined || host === undefined ? null : { name, host };
  },
  run: ({ project, args, env, cwd, stdin }) =>
    o.bin === null
      ? Promise.resolve(NO_DOCKER)
      : run([o.bin, 'compose', '--project-name', project, ...args], env, RUN_TIMEOUT_MS, {
          cwd,
          ...(stdin === undefined ? {} : { stdin }),
        }),
  network: async ({ network, container, leave = false, env }) => {
    if (o.bin === null) return NO_DOCKER;
    const ran = await run(
      [
        o.bin,
        'network',
        leave ? 'disconnect' : 'connect',
        ...(leave ? ['-f'] : []),
        network,
        container,
      ],
      env,
      30_000,
    );

    // joined already, or not on it (or it is gone) when leaving: as asked
    return ran.exit !== 0 &&
      (leave ? /not connected|not found|no such network/i : /already exists/i).test(ran.stderr)
      ? { ...ran, exit: 0 }
      : ran;
  },
  down: ({ project, env }) =>
    o.bin === null
      ? Promise.resolve(NO_DOCKER)
      : run(
          [o.bin, 'compose', '--project-name', project, 'down', '--remove-orphans', '--volumes'],
          env,
          DOWN_TIMEOUT_MS,
        ),
});
