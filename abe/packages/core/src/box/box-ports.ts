/**
 * A dev server on a box, opened on this Mac (#16, like VS Code's Ports). Each box workspace (a
 * card's container, ADR 0022; several on one box, #9) is looked at on its own: the ports a server
 * listens on there (`/proc/net/tcp`, the dev range only) and the ports the repo's auth callback
 * fixes (its env example, as Factory install's Read finds them, #22). The Mac's `serve` holds a
 * forward per workspace and port, `(box, card, port)`: the box's `serve` relays a port on its own
 * loopback into the workspace (`abe port pipe` inside it, so a server bound to 127.0.0.1 there is
 * reached too) and the Mac's ssh forward reaches that relay. The local port is the box's when
 * free, else the next free one, said; a fixed port is that one only (one run at a time). A
 * forward ends when its box sleeps and comes back when it wakes. Offered, never opened by itself.
 */
import { z } from 'zod';
import { readFindings, ENV_EXAMPLES } from '../install/install-read';

/**
 * The ports a dev server is looked for on: 1024 to 32767. Above is the kernel's ephemeral range,
 * where a tool's own listener (Claude Code's sandbox proxy, a debugger) binds port 0 and lands.
 */
export const DEV_PORTS = { first: 1024, last: 32767 } as const;

/** How many ports after the box's a forward tries on this Mac when the box's own is taken. */
export const LOCAL_TRIES = 20;

/** TCP's LISTEN in `/proc/net/tcp`'s `st` column. */
const LISTEN = '0A';

const Port = z.number().int().min(1).max(65535);

/**
 * The dev ports listening in `/proc/net/tcp` and `/proc/net/tcp6` text (both, one after the
 * other; their header lines are skipped), each once, in order.
 */
export const listeningPorts = (procNet: string): number[] => {
  const ports = new Set<number>();

  for (const line of procNet.split('\n')) {
    const cols = line.trim().split(/\s+/);
    const local = cols[1];

    if (cols[3] !== LISTEN || local === undefined) continue;
    const hex = local.split(':').at(-1) ?? '';
    const port = Number.parseInt(hex, 16);

    if (/^[0-9A-Fa-f]{4}$/.test(hex) && port >= DEV_PORTS.first && port <= DEV_PORTS.last)
      ports.add(port);
  }

  return [...ports].sort((a, b) => a - b);
};

/** Between the probe's two parts: what listens, then the repo's env example. */
export const PORTS_PROBE_MARK = '--- abe env example ---';

/**
 * The shell a box's `serve` runs in a workspace (`docker exec`, its own user) to look at it: its
 * listening sockets, then its clone's env example (the first of Read's names), never an env file.
 */
export const portsProbe = (workdir: string): string =>
  [
    'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null',
    `echo '${PORTS_PROBE_MARK}'`,
    `for f in ${ENV_EXAMPLES.join(' ')}; do if [ -f '${workdir}'/"$f" ]; then echo "$f"; cat '${workdir}'/"$f"; break; fi; done`,
  ].join('; ');

/** One workspace's ports: what listens there, and what its repo's auth callback fixes. */
export const WorkspacePorts = z.object({
  card: z.string(),
  ports: z.array(Port),
  /** Ports an auth callback to localhost fixes (Factory install's Read): forwarded to that port only. */
  fixed: z.array(Port),
});
export type WorkspacePorts = z.infer<typeof WorkspacePorts>;

/** What the probe printed, read: its ports and fixed ports (`card` given by the caller). */
export const portsOfProbe = (card: string, out: string): WorkspacePorts => {
  const at = out.indexOf(PORTS_PROBE_MARK);
  const net = at < 0 ? out : out.slice(0, at);
  const rest = at < 0 ? '' : out.slice(at + PORTS_PROBE_MARK.length).replace(/^\n/, '');
  const nl = rest.indexOf('\n');
  const name = (nl < 0 ? rest : rest.slice(0, nl)).trim();
  const files = new Map<string, string>(
    name === '' ? [] : [[name, nl < 0 ? '' : rest.slice(nl + 1)]],
  );

  return {
    card,
    ports: listeningPorts(net),
    fixed: readFindings({ files, board: undefined }).fixedPorts,
  };
};

/** `abe workspace ports`, on a box: each running workspace's ports. */
export const WorkspacePortsList = z.object({ workspaces: z.array(WorkspacePorts) });
export type WorkspacePortsList = z.infer<typeof WorkspacePortsList>;

const portsWords = (ports: readonly number[]): string =>
  ports.length === 0 ? 'nothing listening' : ports.map((p) => `:${p}`).join(' ');

export const workspacePortsText = (l: WorkspacePortsList): string =>
  l.workspaces.length === 0
    ? 'no running workspaces on this box\n'
    : l.workspaces
        .map(
          (w) =>
            `card ${w.card}: ${portsWords(w.ports)}${w.fixed.length === 0 ? '' : ` (fixed ${w.fixed.join(', ')})`}\n`,
        )
        .join('');

/** `abe workspace relay`, on a box: the box's own `127.0.0.1:<relay>` reaching the workspace's port. */
export const WorkspaceRelay = z.object({ card: z.string(), port: Port, relay: Port });
export type WorkspaceRelay = z.infer<typeof WorkspaceRelay>;

export const workspaceRelayText = (r: WorkspaceRelay): string =>
  `card ${r.card}'s port ${r.port}: 127.0.0.1:${r.relay} on this box\n`;

export const PORT_FORWARD_STATES = ['opening', 'open', 'asleep', 'failed'] as const;
export const PortForwardState = z.enum(PORT_FORWARD_STATES);
export type PortForwardState = z.infer<typeof PortForwardState>;

/** A forward the Mac's `serve` holds: a workspace's port on a box, on this Mac's localhost. */
export const PortForward = z.object({
  box: z.string(),
  card: z.string(),
  port: Port,
  /** This Mac's port (127.0.0.1); the box's own when it was free. */
  local: Port,
  state: PortForwardState,
  /** Fixed by the repo's auth callback: only `port` itself will do. */
  fixed: z.boolean(),
  /** Why it failed, or why its local port is not the box's (`localhost:3000 was taken`). */
  note: z.string().optional(),
  since: z.string(),
});
export type PortForward = z.infer<typeof PortForward>;

/** Its key: one forward per workspace and port, however many workspaces a box holds. */
export const forwardKey = (f: { box: string; card: string; port: number }): string =>
  `${f.box}/${f.card}/${String(f.port)}`;

export const forwardUrl = (f: { local: number }): string => `http://localhost:${String(f.local)}`;

const FORWARD_WORDS: Readonly<Record<PortForwardState, string>> = {
  opening: 'opening',
  open: 'open',
  asleep: 'box asleep: back when it wakes',
  failed: 'failed',
};

export const portForwardText = (f: PortForward): string =>
  `${f.box} #${f.card} :${String(f.port)} → localhost:${String(f.local)} · ${FORWARD_WORDS[f.state]}${f.note === undefined ? '' : ` (${f.note})`}\n`;

/** A port listening in a box's workspace that is not forwarded yet: offered. */
export const PortOffer = z.object({
  box: z.string(),
  card: z.string(),
  port: Port,
  fixed: z.boolean(),
});
export type PortOffer = z.infer<typeof PortOffer>;

/** `abe port list`: the forwards held, the ports offered, and the boxes that could not be read. */
export const PortListData = z.object({
  forwards: z.array(PortForward),
  offered: z.array(PortOffer),
  unread: z.array(z.object({ box: z.string(), message: z.string() })),
});
export type PortListData = z.infer<typeof PortListData>;

export const portListText = (l: PortListData): string =>
  [
    l.forwards.length === 0 && l.offered.length === 0 ? 'no ports on your running boxes\n' : '',
    ...l.forwards.map(portForwardText),
    ...l.offered.map(
      (o) =>
        `${o.box} #${o.card} :${String(o.port)} listening · abe port open ${o.box} ${o.card} ${String(o.port)}${o.fixed ? ' (fixed)' : ''}\n`,
    ),
    ...l.unread.map((u) => `${u.box}: not read · ${u.message}\n`),
  ].join('');

/** `abe port pipe`: it answers nothing, its stdout is the connection's. */
export const PortPiped = z.null();

/** `abe port close`: the forward let go of. */
export const PortClosed = z.object({
  box: z.string(),
  card: z.string(),
  port: Port,
  closed: z.literal(true),
});
export type PortClosed = z.infer<typeof PortClosed>;

export const portClosedText = (c: PortClosed): string =>
  `${c.box} #${c.card} :${String(c.port)} no longer forwarded\n`;

/**
 * The local ports to try, in order: the box's own, then the next ones; a fixed one only itself
 * (its auth callback names it).
 */
export const localCandidates = (port: number, fixed: boolean): number[] =>
  fixed
    ? [port]
    : Array.from({ length: LOCAL_TRIES }, (_, i) => port + i).filter((p) => p <= 65535);

/** Why the local port is not the box's: said on the forward. */
export const movedNote = (port: number, local: number): string | undefined =>
  local === port ? undefined : `localhost:${String(port)} was taken`;

/** A fixed port taken on this Mac: one run at a time, and what holds it when a forward does. */
export const fixedTakenText = (port: number, holder: PortForward | undefined): string =>
  `localhost:${String(port)} is taken on this machine and the repo's auth callback is fixed to it: one run at a time · ${
    holder === undefined
      ? 'stop what holds it (the app run locally?)'
      : `abe port close ${holder.box} ${holder.card} ${String(holder.port)} frees it`
  }`;
