/**
 * A box's serve with a workspace per card (ADR 0022): its sessions' terminals, files and git are
 * in their own card's container, so the ports they go through are the card's. The session runner
 * is routed by the session's id (`<card>-<4 hex>`, `cardOfSession`); the git, run tree and
 * transcript ports are asked for by card (`ByCard`) where serve knows the session or run.
 */
import {
  type Answered,
  type ByCard,
  cardOfSession,
  type Docker,
  LABEL,
  type SessionRunner,
  WORKSPACE_PREFIX,
} from '@abe/core';
import { type ContainerExec, containerExec } from '@abe/ports';
import { type WorkspaceDirectory } from './workspace';

const noCard = (id: string): Answered<never> => ({
  ok: false,
  error: { code: 'no-workspace', message: `session ${id} names no card's workspace on this box` },
});

/**
 * The box's workspaces as Docker's labels say now: each one's card and its clone's branch.
 * Rejects when Docker does not answer: never read as "no workspaces".
 */
const workspacesOn = async (docker: Docker) =>
  (await docker.containers(LABEL.role, 'workspace')).flatMap((c) => {
    const card = c.labels[LABEL.card];
    const branch = c.labels[LABEL.branch];

    return card === undefined || branch === undefined
      ? []
      : [{ card, branch, running: c.state === 'running' }];
  });

/**
 * One session runner over every workspace on the box: each call goes to the runner of the
 * session's card (`runnerOf`), Before's worktree to the card whose clone is on its branch;
 * `running` and `attached` ask every running workspace. `abe`, `bin`, `home` and `user` are any
 * runner's (the same base image in each).
 */
export const routedRunner = (o: {
  docker: Docker;
  runnerOf: (card: string) => SessionRunner;
}): SessionRunner => {
  // Any card's runner for what every workspace shares (the same base image's paths).
  const base = o.runnerOf('0');
  const of = (id: string) => {
    const card = cardOfSession(id);

    return card === undefined ? undefined : o.runnerOf(card);
  };
  /** Every running workspace's runner (a stopped container has no sessions). */
  const each = async () =>
    (await workspacesOn(o.docker)).filter((w) => w.running).map((w) => o.runnerOf(w.card));

  return {
    abe: base.abe,
    bin: base.bin,
    ...(base.home === undefined ? {} : { home: base.home }),
    ...(base.user === undefined ? {} : { user: base.user }),
    // the repo's sources as every workspace takes them (3.2.1: the definitions alone)
    ...(base.sourceServers === undefined ? {} : { sourceServers: base.sourceServers }),
    // A session with no card (none comes to a box) gets a socket nothing mounts.
    socket: (id) => (of(id) ?? base).socket(id),
    launch: (spec) => of(spec.id)?.launch(spec) ?? Promise.resolve(noCard(spec.id)),
    baseWorktree: async (repo, branch) => {
      const card = (await workspacesOn(o.docker).catch(() => [])).find(
        (w) => w.branch === branch,
      )?.card;

      return card === undefined
        ? {
            ok: false,
            error: { code: 'no-workspace', message: `no workspace on this box is on ${branch}` },
          }
        : o.runnerOf(card).baseWorktree(repo, branch);
    },
    send: (id, text) => of(id)?.send(id, text) ?? Promise.resolve(noCard(id)),
    keys: (id, keys) => of(id)?.keys(id, keys) ?? Promise.resolve(noCard(id)),
    screen: (id) => of(id)?.screen(id) ?? Promise.resolve(noCard(id)),
    attach: (id) => (of(id) ?? base).attach(id),
    stop: (id) => of(id)?.stop(id) ?? Promise.resolve({ ok: true, data: null }),
    running: async () => {
      // Docker or a workspace not answering fails the look (its sessions are not read as gone);
      // only a stopped container has none.
      const asked = (r: SessionRunner) =>
        r.running().catch((err: unknown): Answered<string[]> => ({
          ok: false,
          error: { code: 'tmux-failed', message: err instanceof Error ? err.message : String(err) },
        }));
      let runners: SessionRunner[];

      try {
        runners = await each();
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'docker-failed',
            message: `the box's workspaces: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
      const all = await Promise.all(runners.map(asked));
      const failed = all.find((r) => !r.ok);

      return failed ?? { ok: true, data: all.flatMap((r) => (r.ok ? r.data : [])) };
    },
    attached: async () =>
      (
        await Promise.all(
          (await each().catch(() => [])).map(
            (r) => r.attached?.().catch(() => false) ?? Promise.resolve(false),
          ),
        )
      ).some((a) => a),
  };
};

/**
 * `docker exec` into any running workspace on the box (its `gh` has the owner's login, as each
 * has): the box's GitHub reads that belong to no one card (the pr stage's polls).
 */
export const anyWorkspaceExec =
  (docker: Docker): ContainerExec =>
  async (argv, o) => {
    const running = (await docker.containers(LABEL.role, 'workspace').catch(() => [])).find(
      (c) => c.state === 'running',
    );

    return running === undefined
      ? { exit: 125, stdout: '', stderr: 'no workspace runs on this box' }
      : containerExec(docker, running.name)(argv, o);
  };

/** A port built on the card's own workspace container, made once per container. */
export const byContainer = <T>(
  directory: WorkspaceDirectory,
  make: (container: string) => T,
): ByCard<T> => {
  const made = new Map<string, T>();

  return (card) => {
    // A session with no card (none runs on a box) reaches no container.
    const container =
      card === null ? `${WORKSPACE_PREFIX}none` : directory.namesOf(String(card)).container;
    const had = made.get(container);

    if (had !== undefined) return had;
    const port = make(container);

    made.set(container, port);

    return port;
  };
};
