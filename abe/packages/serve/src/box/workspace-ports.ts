/**
 * A box's side of a dev server forwarded to the Mac (#16): `abe workspace ports` looks in each
 * running workspace, `abe workspace relay` keeps the box's own loopback port reaching one, and a
 * watcher says `workspace.ports` when what listens changes. Keyed per workspace (card).
 */
import {
  type Docker,
  type EventData,
  type Outcome,
  portsOfProbe,
  portsProbe,
  type RelayHeld,
  refused,
  type WorkspacePorts,
  type WorkspaceRelay,
  type WorkspaceRelays,
  type Handlers,
} from '@abe/core';
import { type Box } from './workspace';

/** How often the box's serve looks at what listens in its workspaces. */
export const PORTS_EVERY_MS = 3_000;

/** A probe that does not answer in this long leaves that workspace out of the look. */
const PROBE_TIMEOUT_MS = 10_000;

export type WorkspacePortsService = {
  /** Each running workspace's ports (only `card`'s when given); one that does not answer is left out. */
  list: (card?: string) => Promise<WorkspacePorts[]>;
  /** The box's 127.0.0.1 port reaching the card's workspace's `port`: kept, reused while open. */
  relay: (card: string, port: number) => Promise<Outcome<WorkspaceRelay>>;
  /** The card's workspace went (removed, stopped): its relays end. */
  drop: (card: string) => Promise<void>;
  /** One look now, as the watcher's: `workspace.ports` for each card that changed. */
  look: () => Promise<void>;
  stop: () => Promise<void>;
};

export type WorkspacePortsOptions = {
  box: Box;
  docker: Docker;
  relays: WorkspaceRelays | undefined;
  emit: (data: EventData<'workspace.ports'>) => void;
  /** How often the watcher looks (default `PORTS_EVERY_MS`). */
  everyMs?: number;
  log?: (message: string) => void;
};

const same = (a: WorkspacePorts, b: WorkspacePorts) =>
  a.ports.join(',') === b.ports.join(',') && a.fixed.join(',') === b.fixed.join(',');

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const startWorkspacePorts = (o: WorkspacePortsOptions): WorkspacePortsService => {
  /** Each relay open, by `card/port`. */
  const relays = new Map<string, Promise<RelayHeld>>();
  /** What the watcher last said per card. */
  const last = new Map<string, WorkspacePorts>();
  let stopped = false;

  const probe = async (w: {
    card: string;
    container: string;
    workdir: string;
  }): Promise<WorkspacePorts | undefined> => {
    const ran = await o.docker
      .exec(w.container, ['sh', '-c', portsProbe(w.workdir)], undefined, {
        timeoutMs: PROBE_TIMEOUT_MS,
      })
      .catch(() => undefined);

    return ran?.exit === 0 ? portsOfProbe(w.card, ran.stdout) : undefined;
  };

  const list = async (card?: string) => {
    const running = (await o.box.running()).filter((w) => card === undefined || w.card === card);

    return (await Promise.all(running.map(probe))).flatMap((p) => p ?? []);
  };

  const relayCards = () => new Set([...relays.keys()].map((k) => k.slice(0, k.lastIndexOf('/'))));

  const drop = async (card: string) => {
    for (const [key, held] of [...relays]) {
      if (!key.startsWith(`${card}/`)) continue;
      relays.delete(key);
      await (await held.catch(() => undefined))?.close();
    }
  };

  const relay = async (card: string, port: number): Promise<Outcome<WorkspaceRelay>> => {
    if (o.relays === undefined)
      return refused('not-built', 'this abe serve has no relays into its workspaces');
    if (stopped) return refused('serve-stopping', 'this abe serve is stopping');
    const w = (await o.box.running()).find((r) => r.card === card);

    if (w === undefined) {
      await drop(card);

      return refused(
        'no-workspace',
        `card ${card} has no running workspace on this box: abe workspace up`,
      );
    }
    const key = `${card}/${String(port)}`;
    let held = relays.get(key);

    if (held === undefined) {
      held = o.relays.open(w.container, port);
      relays.set(key, held);
    }
    try {
      return { ok: true, data: { card, port, relay: (await held).port } };
    } catch (err) {
      relays.delete(key);

      return refused('relay-failed', `card ${card}'s port ${String(port)}: ${why(err)}`);
    }
  };

  let looking: Promise<void> | undefined;
  const lookOnce = async () => {
    const running = await o.box.running();
    const now = (await Promise.all(running.map(probe))).flatMap((p) => p ?? []);
    const seen = new Set(running.map((w) => w.card));

    for (const p of now) {
      const was = last.get(p.card);

      // First look: said only when something is there.
      if (was === undefined ? p.ports.length + p.fixed.length > 0 : !same(was, p)) o.emit(p);
      last.set(p.card, p);
    }
    for (const [card, was] of [...last]) {
      if (seen.has(card)) continue;
      // Gone (stopped, removed): said empty once, its relays end, then forgotten.
      if (was.ports.length + was.fixed.length > 0) o.emit({ card, ports: [], fixed: [] });
      last.delete(card);
    }
    for (const card of relayCards()) if (!seen.has(card)) await drop(card);
  };
  const look = () => {
    looking ??= lookOnce()
      .catch((err: unknown) => {
        o.log?.(`the workspaces' ports were not read: ${why(err)}`);
      })
      .finally(() => {
        looking = undefined;
      });

    return looking;
  };
  const timer = setInterval(() => void look(), o.everyMs ?? PORTS_EVERY_MS);

  timer.unref();

  return {
    list,
    relay,
    drop,
    look,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await looking;
      for (const card of relayCards()) await drop(card);
    },
  };
};

export type WorkspacePortsCtx = {
  serve: {
    box: Box | undefined;
    workspacePorts: WorkspacePortsService | undefined;
  };
};

const NOT_A_BOX = refused(
  'not-a-box',
  'this abe serve runs no workspace (a box starts it with ABE_BOX set)',
);

export const workspacePortsHandlers = <C extends WorkspacePortsCtx>() =>
  ({
    'workspace ports': async (args, ctx) => {
      if (ctx.serve.box === undefined || ctx.serve.workspacePorts === undefined) return NOT_A_BOX;
      try {
        return { ok: true, data: { workspaces: await ctx.serve.workspacePorts.list(args.card) } };
      } catch (err) {
        return refused('docker-failed', why(err));
      }
    },
    'workspace relay': (args, ctx) =>
      ctx.serve.box === undefined || ctx.serve.workspacePorts === undefined
        ? Promise.resolve(NOT_A_BOX)
        : ctx.serve.workspacePorts.relay(args.card, args.port),
  }) satisfies Partial<Handlers<C>>;
