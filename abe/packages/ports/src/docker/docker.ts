/** The box's Docker through the `docker` CLI: argv in, its output read with zod; no rules here. */
import { type Container, type ContainerSpec, type Docker, type Image, type Ran } from '@abe/core';
import { z } from 'zod';
import { type Env } from '../mac/locations';

export type DockerOptions = {
  /** The `docker` to run (default: `docker` on `PATH`). */
  bin?: string;
  env: Env;
};

/** How long an `exec` may run by default, and the exit one killed for it answers (as `timeout`). */
const EXEC_TIMEOUT_MS = 60_000;
export const EXEC_TIMED_OUT = 124;

const Labels = z.record(z.string(), z.string()).nullable().catch(null);

const Inspected = z.array(
  z.object({
    Name: z.string(),
    State: z.object({ Status: z.string() }),
    Config: z.object({ Labels }),
  }),
);

const ImageInspected = z.array(z.object({ Id: z.string(), Config: z.object({ Labels }) }));

/**
 * `docker run`'s flags for a spec, before the image. An env var goes by name only (`--env NAME`):
 * its value rides in the docker CLI's own environment, never in an argv `ps` shows.
 */
export const runFlags = (spec: ContainerSpec): string[] => {
  const flags: string[] = [];
  const add = (...more: string[]) => flags.push(...more);

  if (spec.name !== undefined) add('--name', spec.name);
  if (spec.hostname !== undefined) add('--hostname', spec.hostname);
  for (const [k, v] of Object.entries(spec.labels)) add('--label', `${k}=${v}`);
  for (const k of Object.keys(spec.env)) add('--env', k);
  for (const m of spec.mounts) {
    const parts = [`type=${m.type}`, `source=${m.source}`, `target=${m.target}`];

    add('--mount', m.readOnly === true ? [...parts, 'readonly'].join(',') : parts.join(','));
  }
  add('--network', spec.network);
  for (const p of spec.publish ?? []) add('--publish', `${p.host}:${p.port}:${p.target}`);
  if (spec.workdir !== undefined) add('--workdir', spec.workdir);
  if (spec.limits !== undefined)
    add(
      '--memory',
      spec.limits.memory,
      '--memory-swap',
      spec.limits.memory,
      '--pids-limit',
      String(spec.limits.pids),
      '--shm-size',
      spec.limits.shm,
    );
  if (spec.hardened === true) add('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
  if (spec.seccomp !== undefined) add('--security-opt', `seccomp=${spec.seccomp}`);
  if (spec.apparmor !== undefined) add('--security-opt', `apparmor=${spec.apparmor}`);
  if (spec.systemPaths !== undefined) add('--security-opt', `systempaths=${spec.systemPaths}`);
  if (spec.restart !== undefined) add('--restart', spec.restart);

  return flags;
};

/** A stream read to its end as text, each whole line handed to `onLine` as it comes. */
const linesOf = async (
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<string> => {
  const decoder = new TextDecoder();
  let all = '';
  let rest = '';

  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });

    all += text;
    const lines = (rest + text).split(/\r?\n/);

    rest = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  }
  const last = decoder.decode();

  all += last;
  rest += last;
  if (rest !== '') onLine(rest);

  return all;
};

/** `docker system df -v`'s volumes: each one's name and its size as Docker words it. */
const VolumeList = z.array(z.object({ Name: z.string(), Size: z.string() }));

const UNITS: Readonly<Record<string, number>> = {
  B: 1,
  kB: 1e3,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  PB: 1e15,
};

/** Docker's size words (`4.1GB`, `63B`: decimal units, go-units' HumanSize) as bytes; 0 for "N/A". */
export const bytesOf = (size: string): number => {
  const m = /^([\d.]+)\s*([kKMGTP]?B)$/.exec(size.trim());
  const unit = m?.[2] === undefined ? undefined : UNITS[m[2]];

  return m?.[1] === undefined || unit === undefined ? 0 : Math.round(Number(m[1]) * unit);
};

export const dockerCli = (o: DockerOptions): Docker => {
  const bin = o.bin ?? 'docker';
  const env = Object.fromEntries(
    Object.entries(o.env).filter((e): e is [string, string] => e[1] !== undefined),
  );

  const ran = async (
    args: readonly string[],
    stdin?: string,
    extra: Readonly<Record<string, string>> = {},
    timeoutMs?: number,
    /** Each line of its stderr as it comes (a build's progress). */
    onLine?: (line: string) => void,
  ): Promise<Ran> => {
    const child = Bun.spawn([bin, ...args], {
      env: { ...env, ...extra },
      stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const late = { killed: false };
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            late.killed = true;
            child.kill('SIGKILL');
          }, timeoutMs);
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      onLine === undefined ? new Response(child.stderr).text() : linesOf(child.stderr, onLine),
      child.exited,
    ]).finally(() => {
      clearTimeout(timer);
    });

    return late.killed
      ? { exit: EXEC_TIMED_OUT, stdout, stderr: `${stderr}docker ${args[0] ?? ''} timed out\n` }
      : { exit, stdout, stderr };
  };

  /** Docker's own refusal, as an error naming the command. */
  const must = async (
    args: readonly string[],
    stdin?: string,
    extra: Readonly<Record<string, string>> = {},
  ): Promise<string> => {
    const out = await ran(args, stdin, extra);

    if (out.exit !== 0)
      throw new Error(`docker ${args[0] ?? ''} failed: ${out.stderr.trim() || `exit ${out.exit}`}`);

    return out.stdout;
  };

  return {
    containers: async (key, value) => {
      const ids = (await must(['ps', '-aq', '--no-trunc', '--filter', `label=${key}=${value}`]))
        .split('\n')
        .filter((id) => id !== '');

      if (ids.length === 0) return [];

      return Inspected.parse(
        JSON.parse(await must(['inspect', '--type', 'container', ...ids])),
      ).map((c): Container => ({
        name: c.Name.replace(/^\//, ''),
        state: c.State.Status,
        labels: c.Config.Labels ?? {},
      }));
    },
    image: async (ref) => {
      const out = await ran(['image', 'inspect', ref]);

      if (out.exit !== 0 && /no such image/i.test(out.stderr)) return undefined;
      if (out.exit !== 0)
        throw new Error(`docker image failed: ${out.stderr.trim() || `exit ${out.exit}`}`);
      const [found] = ImageInspected.parse(JSON.parse(out.stdout));

      return found === undefined
        ? undefined
        : ({ id: found.Id, labels: found.Config.Labels ?? {} } satisfies Image);
    },
    build: (b) =>
      ran(
        [
          'build',
          '--tag',
          b.tag,
          '--file',
          b.dockerfile,
          ...Object.entries(b.contexts ?? {}).flatMap(([k, v]) => ['--build-context', `${k}=${v}`]),
          ...Object.entries(b.args).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]),
          ...Object.entries(b.labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
          b.context,
        ],
        undefined,
        {},
        undefined,
        b.progress,
      ),
    network: async (name) => {
      if ((await ran(['network', 'inspect', name])).exit === 0) return;
      await must(['network', 'create', name]);
    },
    removeNetwork: async (name) => {
      const out = await ran(['network', 'rm', name]);

      // Gone already is what was asked.
      if (out.exit !== 0 && !/not found|no such network/i.test(out.stderr))
        throw new Error(`docker network failed: ${out.stderr.trim() || `exit ${out.exit}`}`);
    },
    run: async (spec) => {
      await must(
        ['run', '--detach', ...runFlags(spec), spec.image, ...(spec.argv ?? [])],
        undefined,
        spec.env,
      );
    },
    once: (spec) =>
      ran(
        ['run', '--rm', ...runFlags(spec), spec.image, ...(spec.argv ?? [])],
        undefined,
        spec.env,
      ),
    confinement: async (image, apparmor) => {
      // The kernel's own word for the process' confinement (AppArmor's file where LSMs stack).
      const read =
        'cat /proc/self/attr/apparmor/current 2>/dev/null || cat /proc/self/attr/current';

      return (
        await must([
          'run',
          '--rm',
          ...runFlags({
            image,
            labels: { 'abe.role': 'apparmor-check' },
            env: {},
            mounts: [],
            network: 'none',
            hardened: true,
            apparmor,
          }),
          image,
          'sh',
          '-c',
          read,
        ])
      ).trim();
    },
    exec: (name, argv, stdin, opts) =>
      ran(
        [
          'exec',
          ...(stdin === undefined ? [] : ['--interactive']),
          ...(opts?.user === undefined ? [] : ['--user', opts.user]),
          name,
          ...argv,
        ],
        stdin,
        {},
        opts?.timeoutMs ?? EXEC_TIMEOUT_MS,
      ),
    start: async (name) => {
      await must(['start', name]);
    },
    remove: async (name) => {
      await must(['rm', '--force', name]);
    },
    volumeSizes: async () => {
      const read = VolumeList.safeParse(
        JSON.parse(await must(['system', 'df', '-v', '--format', '{{json .Volumes}}'])),
      );

      if (!read.success) throw new Error(`docker system df: ${read.error.message}`);

      return Object.fromEntries(read.data.map((v) => [v.Name, bytesOf(v.Size)]));
    },
    volumePath: async (name) => {
      const out = await ran(['volume', 'inspect', '--format', '{{.Mountpoint}}', name]);
      const path = out.stdout.trim();

      return out.exit === 0 && path !== '' ? path : undefined;
    },
    removeVolume: async (name) => {
      const out = await ran(['volume', 'rm', name]);

      // Gone already is what was asked.
      if (out.exit !== 0 && !/no such volume/i.test(out.stderr))
        throw new Error(`docker volume failed: ${out.stderr.trim() || `exit ${out.exit}`}`);
    },
  };
};
