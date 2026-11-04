/**
 * The CLI seam. It runs the real `abe` as a process against a temporary state directory, as a
 * script would. That is the entry script under Bun or a compiled binary. `close()` stops a `serve`
 * it starts. The serve also stops itself once the test process is gone, through
 * `ABE_SERVE_OWNER_PID`.
 */
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { type Envelope, readEnvelope, StatusData } from '@abe/core';
import { type z } from 'zod';
import { killTmux, tmuxPath } from '../tools/claude';
import { tempState, type TempState } from './state';
import { streaming, type Streaming } from './stream';

export type Ran = { exit: number; stdout: string; stderr: string };

export type RunOptions = { stdin?: string; env?: Record<string, string>; cwd?: string };

export type Cli = {
  state: TempState;
  /** `abe <argv…>`, to its exit. */
  run: (...argv: string[]) => Promise<Ran>;
  /**
   * `abe <argv…>` to its exit, with `stdin`, more environment such as a session's `ABE_SOCKET`,
   * and typed in `cwd`. `cwd` defaults to the state directory.
   */
  runWith: (o: RunOptions, ...argv: string[]) => Promise<Ran>;
  /** `abe <argv…> --json`, its document read with `data`'s schema. Fails on more than one line. */
  json: <T extends z.ZodType>(
    data: T,
    ...argv: string[]
  ) => Promise<{ exit: number; stderr: string; doc: Envelope<z.output<T>> }>;
  /** `json`, run as `runWith` runs. */
  jsonWith: <T extends z.ZodType>(
    o: RunOptions,
    data: T,
    ...argv: string[]
  ) => Promise<{ exit: number; stderr: string; doc: Envelope<z.output<T>> }>;
  /** `abe <argv…>` left running, like `abe watch`, its stdout read line by line. */
  spawn: (...argv: string[]) => Streaming;
  /** One raw line to the socket and the line it answers. */
  raw: (line: string) => Promise<string>;
  /**
   * Stops a `serve` this CLI started with `abe serve stop`, then SIGKILL, and removes the state.
   */
  close: () => Promise<void>;
};

const ENTRY = join(import.meta.dir, '..', '..', '..', 'serve', 'src', 'main.ts');

export type CliOptions = {
  /** A compiled `abe`. Defaults to Bun on `serve/src/main.ts`. */
  binary?: string;
  /** More variables beside the temporary state's own. */
  env?: Record<string, string>;
  /** Where a run is typed unless it says (`RunOptions.cwd`); defaults to the state directory. */
  cwd?: string;
};

/**
 * The `serve` processes running on state directory `dir`, matched by their `ABE_STATE_DIR`. It
 * reads that from `ps -E`, which shows this user's processes' environments. This finds a test's
 * serve even when nothing asks it any more.
 */
export const servesOf = (dir: string): number[] => {
  const ps = Bun.spawnSync(['ps', '-axwwE', '-o', 'pid=,command=']).stdout.toString();
  const pids: number[] = [];

  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);

    if (m === null) continue;
    const [, pid = '', rest = ''] = m;
    const envAt = rest.search(/\s[A-Z_][A-Z0-9_]*=/);
    const argv = envAt < 0 ? rest : rest.slice(0, envAt);
    const env = envAt < 0 ? '' : `${rest.slice(envAt)} `;

    if (/(^|\s)serve(\s|$)/.test(argv) && env.includes(` ABE_STATE_DIR=${dir} `))
      pids.push(Number(pid));
  }

  return pids;
};

/** The state of every `cli()` not closed yet, which `stopLeftServes` ends. */
const open = new Set<TempState>();

/**
 * Ends the serves and tmux servers of every `cli()` a test did not close, and removes their state.
 * A test that failed or timed out before its `close()` then leaves none running. `preload.ts`,
 * set in bunfig.toml, runs this after every `bun test`, since `bun test` emits no `exit` a module
 * could catch.
 */
export const stopLeftServes = (): void => {
  for (const state of open) {
    for (const pid of servesOf(state.dir)) {
      // its process group when it leads one, children included, else the serve alone
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, 'SIGKILL');
          break;
        } catch {
          // no such group, or gone already
        }
      }
    }
    const tmux = join(state.dir, 'tmux.sock');

    if (existsSync(tmux)) {
      try {
        Bun.spawnSync([tmuxPath(), '-S', tmux, 'kill-server'], {
          stdout: 'ignore',
          stderr: 'ignore',
        });
      } catch {
        // no tmux means no tmux server either
      }
    }
    state.remove();
    open.delete(state);
  }
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

export const cli = (o: CliOptions = {}): Cli => {
  const state = tempState();
  const argv0 = o.binary === undefined ? [process.execPath, ENTRY] : [o.binary];

  open.add(state);

  const runWith: Cli['runWith'] = async (w, ...argv) => {
    const child = Bun.spawn([...argv0, ...argv], {
      env: { ...state.env, ...o.env, ...w.env },
      cwd: w.cwd ?? o.cwd ?? state.dir,
      stdin: w.stdin === undefined ? 'ignore' : new TextEncoder().encode(w.stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return { exit, stdout, stderr };
  };

  const run = (...argv: string[]) => runWith({}, ...argv);

  const jsonWith: Cli['jsonWith'] = async (w, data, ...argv) => {
    const out = await runWith(w, ...argv, '--json');
    const lines = out.stdout.split('\n').filter((l) => l !== '');

    if (lines.length !== 1)
      throw new Error(`expected one JSON line, got: ${out.stdout}${out.stderr}`);
    const doc = readEnvelope(data, JSON.parse(lines[0] ?? ''));

    return { exit: out.exit, stderr: out.stderr, doc };
  };

  const json: Cli['json'] = (data, ...argv) => jsonWith({}, data, ...argv);

  const spawn = (...argv: string[]) =>
    streaming([...argv0, ...argv], { ...state.env, ...o.env }, o.cwd ?? state.dir);

  const raw = (line: string) =>
    new Promise<string>((resolve, reject) => {
      let answer = '';
      const conn = createConnection(state.socket);

      conn.setEncoding('utf8');
      conn.on('connect', () => conn.write(`${line}\n`));
      conn.on('data', (chunk: string) => {
        answer += chunk;
      });
      conn.on('end', () => {
        resolve(answer.trimEnd());
      });
      conn.on('error', reject);
    });

  const close = async () => {
    const status = await json(StatusData, 'status', '--no-start').catch(() => undefined);

    try {
      await run('serve', 'stop');
    } finally {
      if (status?.doc.ok === true) {
        const { pid } = status.doc.data;

        for (let i = 0; i < 40 && alive(pid); i += 1) await Bun.sleep(25);
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
      // Sessions outlive their serve, so end the tmux server it started, if any.
      await killTmux(state.dir);
      state.remove();
      open.delete(state);
    }
  };

  return { state, run, runWith, json, jsonWith, spawn, raw, close };
};
