/**
 * A stand-in workspace container for a box's `serve` in a test. The fake Docker's `exec` into any
 * card's workspace runs for real on this machine. That is `abe-ws-<card>`, or an old box's
 * `abe-workspace`. It all runs in one temporary root that holds the container's home, clone,
 * managed settings and its own `tmux` server. It gets the container's environment, such as
 * `DATABASE_URL` and `ABE_WORKSPACE`, and a `PATH` with the fake `claude` and `gh`. The workspace
 * runner then starts the fake `claude` in a real `tmux`, as it starts the real one in a container.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LABEL, type Ran, type SessionRunner, workspaceNames } from '@abe/core';
import { containerExec, workspaceRunner } from '@abe/ports';
import { routedRunner } from '@abe/serve';
import { fakeClaude, type FakeClaude, tmuxPath } from '../tools/claude';
import { type FakeDocker } from './docker';

const ENTRY = join(import.meta.dir, '..', '..', '..', 'serve', 'src', 'main.ts');

export type StandIn = {
  root: string;
  home: string;
  workdir: string;
  managed: string;
  /** The folder that holds `abe`, a shim for this checkout's, and nothing else. */
  bin: string;
  /** The fake `claude`, reading the stand-in's managed settings. */
  claude: FakeClaude;
  runner: SessionRunner;
  /** Ends the stand-in's `tmux` server and removes its root. */
  remove: () => Promise<void>;
};

const run = async (
  argv: readonly string[],
  stdin: string | undefined,
  env: Record<string, string>,
  cwd: string,
): Promise<Ran> => {
  const child = Bun.spawn([...argv], {
    env,
    cwd,
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
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

export const standInWorkspace = (o: {
  docker: FakeDocker;
  /**
   * The box's state directory. Each card's socket folder, `workspaces/<card>`, is under it, and
   * the container sees it at the same path here.
   */
  stateDir: string;
  /** Folders before the system's tools on the container's `PATH`, such as a fake `gh`'s. */
  path: readonly string[];
}): StandIn => {
  const root = mkdtempSync(join(tmpdir(), 'ws-'));
  const home = join(root, 'home');
  const workdir = join(root, 'repo');
  const managed = join(root, 'etc', 'claude-code', 'managed-settings.json');
  const bin = join(root, 'bin');
  const tmuxSocket = join(root, 't.sock');
  const tmux = [tmuxPath(), '-u', '-S', tmuxSocket, '-f', '/dev/null'];
  const claude = fakeClaude({ managed });

  for (const dir of [home, workdir, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(bin, 'abe'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(ENTRY)} "$@"\n`,
    { mode: 0o755 },
  );
  const before = o.docker.onExec;
  /** A workspace container is one `workspace up` labelled so. Any card's stands in here. */
  const isWorkspace = (name: string) =>
    o.docker.containersByName.get(name)?.spec.labels[LABEL.role] === 'workspace';

  o.docker.onExec = (name, argv, stdin, user) => {
    if (!isWorkspace(name)) return before(name, argv, stdin, user);
    const spec = o.docker.containersByName.get(name)?.spec;
    const card = spec?.labels[LABEL.card];

    return run(
      argv,
      stdin,
      {
        // the base image's: the workspace's own serve socket, where its mount is here
        ...(card === undefined
          ? {}
          : { ABE_SOCKET: join(o.stateDir, workspaceNames(card).socketDir, 'serve.sock') }),
        ...spec?.env,
        HOME: home,
        PATH: [bin, claude.dir, ...o.path, '/usr/bin', '/bin'].join(':'),
        LANG: 'en_US.UTF-8',
      },
      workdir,
    );
  };
  const runner = routedRunner({
    docker: o.docker,
    runnerOf: (card) => {
      const names = workspaceNames(card);
      const socketDir = join(o.stateDir, names.socketDir);

      return workspaceRunner({
        exec: containerExec(o.docker, names.container),
        socketDir,
        socketMount: socketDir,
        attachVia: [],
        paths: {
          home,
          workdir,
          managedSettings: managed,
          tmux,
          claude: join(claude.dir, 'claude'),
          abe: join(bin, 'abe'),
          // the workspace volume's folder for them, where a new container's home finds them
          conversations: join(root, 'volume', 'claude-conversations'),
        },
      });
    },
  });

  return {
    root,
    home,
    workdir,
    managed,
    bin,
    claude,
    runner,
    remove: async () => {
      claude.remove();
      if (existsSync(tmuxSocket))
        await Bun.spawn([...tmux, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' }).exited;
      rmSync(root, { recursive: true, force: true });
    },
  };
};
