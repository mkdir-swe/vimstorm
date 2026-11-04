/**
 * A fake EC2 Instance Connect Endpoint with a box behind it. Abe's real tunnel client
 * (`abe box tunnel`, `$ABE_EICE_URL`) talks to it in tests. It checks SigV4 on `SendSSHPublicKey`
 * and on the `openTunnel` handshake exactly as AWS would sign them. It keeps each pushed key for
 * 60 s and runs each connection's command on this machine as the box. The fake `ssh` speaks
 * `wire.ts` through the tunnel, and a ControlMaster's connection carries each call as a channel.
 *
 * A test can cut the network (`outage`) and see the tunnel's 1 h cap (`maxTunnelDuration`). It can
 * refuse a box (`deny`), the next pushes (`failPushes`) or every handshake (`refuseTunnels`). AWS
 * answers a bad signature that way, with a status and no upgrade.
 */
import { type Subprocess } from 'bun';
import { z } from 'zod';
import { presignUrl, signedHeaders } from '@abe/ports';
import { chan, FRAME, frame, type Hello, reader, unchan } from './wire';

const HelloDoc = z.object({
  key: z.string(),
  user: z.string(),
  command: z.string().nullable(),
  tty: z.boolean(),
  forward: z.number().optional(),
  mux: z.boolean().optional(),
});
const helloOf = (payload: Uint8Array): Hello => {
  const h = HelloDoc.parse(JSON.parse(new TextDecoder().decode(payload)));
  const { forward, mux, ...rest } = h;

  return {
    ...rest,
    ...(forward === undefined ? {} : { forward }),
    ...(mux === undefined ? {} : { mux }),
  };
};
const ChannelDoc = z.object({ command: z.string().nullable(), tty: z.boolean() });
const PushDoc = z.object({
  InstanceId: z.string(),
  InstanceOSUser: z.string(),
  SSHPublicKey: z.string(),
});

export const FAKE_KEYS = {
  accessKeyId: 'ASIAFAKEEICE00000001',
  secretAccessKey: 'fake-eice-secret',
  sessionToken: 'fake-eice-token',
};

export type Pushed = { instance: string; user: string; key: string; at: number };
export type Tunnel = { endpoint: string; ip: string; port: number; max: number | null; at: number };
/** `channel` marks a call on a master's connection, not a connection of its own. */
export type BoxRan = {
  command: string | null;
  tty: boolean;
  forward: number | null;
  channel: boolean;
  at: number;
};

export type FakeEice = {
  /** `$ABE_EICE_URL`. */
  url: string;
  pushes: () => Pushed[];
  tunnels: () => Tunnel[];
  /** Each connection that got past the key check, and each channel on a master's. */
  ran: () => BoxRan[];
  /** Tunnels open now. */
  open: () => number;
  /** Takes the network down for `ms`. Open tunnels die at once and new ones get no answer. */
  outage: (ms: number) => void;
  /** Whether an outage is still on and the network is not back yet. */
  isDown: () => boolean;
  /** Refuses push and tunnel requests for `instance`, as if there were no right to it. */
  deny: (instance: string) => void;
  /** Answers each `openTunnel` handshake with `status`. Null upgrades them again. */
  refuseTunnels: (status: number | null) => void;
  /** The next `n` `SendSSHPublicKey`s fail with a 500, a hiccup rather than a refusal. */
  failPushes: (n: number) => void;
  stop: () => void;
};

type Conn = {
  hello?: Hello;
  child?: Subprocess<'pipe', 'pipe', 'pipe'>;
  /** A master's connection keeps its channels' commands here. */
  channels?: Map<number, Subprocess<'pipe', 'pipe', 'pipe'>>;
  socket?: { write: (b: Uint8Array) => number; end: () => void };
  feed: (chunk: Uint8Array) => void;
  timer?: ReturnType<typeof setTimeout>;
};

const amzDate = (text: string) =>
  new Date(
    `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(9, 11)}:${text.slice(11, 13)}:${text.slice(13, 15)}Z`,
  );

const REGION = 'eu-west-1';

/** Whether `url` is the one abe's tunnel signs with FAKE_KEYS, still in its 60 s. */
const signedRight = (url: URL): boolean => {
  const date = url.searchParams.get('X-Amz-Date') ?? '';
  const given = url.searchParams.get('X-Amz-Signature') ?? '';
  const plain = new URL(`${url.protocol}//${url.host}${url.pathname}`);

  for (const [k, v] of url.searchParams) if (!k.startsWith('X-Amz-')) plain.searchParams.set(k, v);
  const again = new URL(
    presignUrl(
      plain,
      { service: 'ec2-instance-connect', region: REGION, keys: FAKE_KEYS, now: amzDate(date) },
      Number(url.searchParams.get('X-Amz-Expires') ?? '0'),
    ),
  );

  return (
    again.searchParams.get('X-Amz-Signature') === given &&
    Date.now() - amzDate(date).getTime() < 60_000
  );
};

export type FakeEiceOptions = {
  /** The box behind it, by instance and private address. */
  instance: string;
  ip: string;
  /** More boxes behind it, sharing the box shell, each with its own instance and address. */
  also?: readonly { instance: string; ip: string }[];
  /** The box's environment and folder for each connection's command. */
  env: Record<string, string>;
  cwd: string;
};

export const fakeEice = (o: FakeEiceOptions): FakeEice => {
  const pushes: Pushed[] = [];
  const tunnels: Tunnel[] = [];
  const ran: BoxRan[] = [];
  const denied = new Set<string>();
  const live = new Set<{ terminate: () => void }>();
  let downUntil = 0;
  let refuseWith: number | null = null;
  let pushFailures = 0;
  const down = () => Date.now() < downUntil;

  const boxes = [{ instance: o.instance, ip: o.ip }, ...(o.also ?? [])];
  /** A key lets in only on the instance it was pushed to. */
  const keyOk = (h: Hello, instance: string) =>
    pushes.some(
      (p) =>
        p.instance === instance &&
        p.user === h.user &&
        p.key === h.key &&
        Date.now() - p.at < 60_000,
    );

  const server = Bun.serve<Conn & { max: number | null; instance: string }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req, srv) => {
      const url = new URL(req.url);

      // While the network is down nothing answers until it is back or a client gives up.
      if (down()) {
        await Bun.sleep(Math.min(downUntil - Date.now(), 5_000));

        return new Response('', { status: 504 });
      }
      if (req.method === 'POST') {
        const body = await req.text();
        const headers = Object.fromEntries(
          [...req.headers.entries()].filter(([k]) =>
            ['content-type', 'x-amz-target'].includes(k.toLowerCase()),
          ),
        );
        const again = signedHeaders(
          { method: 'POST', url: new URL(req.url), headers, body },
          {
            service: 'ec2-instance-connect',
            region: REGION,
            keys: FAKE_KEYS,
            now: amzDate(req.headers.get('x-amz-date') ?? ''),
          },
        );

        if (again.authorization !== req.headers.get('authorization'))
          return Response.json(
            { __type: 'InvalidSignatureException', message: 'signature does not match' },
            { status: 403 },
          );
        const ask = PushDoc.parse(JSON.parse(body));

        if (pushFailures > 0) {
          pushFailures -= 1;

          return Response.json(
            { __type: 'ServiceException', Message: 'try again' },
            { status: 500 },
          );
        }

        if (denied.has(ask.InstanceId))
          return Response.json(
            { __type: 'AccessDeniedException', Message: `not authorized for ${ask.InstanceId}` },
            { status: 400 },
          );
        pushes.push({
          instance: ask.InstanceId,
          user: ask.InstanceOSUser,
          key: ask.SSHPublicKey.split(' ').slice(0, 2).join(' '),
          at: Date.now(),
        });

        return Response.json({ RequestId: 'fake', Success: true });
      }
      if (url.pathname !== '/openTunnel') return new Response('no', { status: 404 });
      if (refuseWith !== null)
        return Response.json({ ErrorCode: 'Refused', Message: 'refused' }, { status: refuseWith });
      if (!signedRight(url))
        return Response.json({ message: 'The request signature does not match' }, { status: 403 });
      const ip = url.searchParams.get('privateIpAddress') ?? '';

      const at = boxes.find((b) => b.ip === ip);

      if (at === undefined)
        return Response.json({ message: `no instance at ${ip}` }, { status: 400 });
      if (denied.has(at.instance))
        return Response.json(
          { message: `not authorized to open a tunnel to ${ip}` },
          { status: 403 },
        );
      const maxText = url.searchParams.get('maxTunnelDuration');
      const max = maxText === null ? null : Number(maxText);

      tunnels.push({
        endpoint: url.searchParams.get('instanceConnectEndpointId') ?? '',
        ip,
        port: Number(url.searchParams.get('remotePort')),
        max,
        at: Date.now(),
      });
      if (srv.upgrade(req, { data: { max, instance: at.instance, feed: () => undefined } }))
        return undefined;

      return new Response('a WebSocket only', { status: 400 });
    },
    websocket: {
      open: (ws) => {
        live.add(ws);
        const c = ws.data;
        const send = (type: number, payload: Uint8Array | string) => ws.send(frame(type, payload));

        if (c.max !== null)
          c.timer = setTimeout(() => {
            ws.close(1000, 'max tunnel duration');
          }, c.max * 1000);
        c.feed = reader((type, payload) => {
          if (type === FRAME.hello) {
            const h = helloOf(payload);

            c.hello = h;
            if (!keyOk(h, c.instance)) {
              send(FRAME.err, `${h.user}@box: Permission denied (publickey).\n`);
              ws.close(1000);

              return;
            }
            ran.push({
              command: h.command,
              tty: h.tty,
              forward: h.forward ?? null,
              channel: false,
              at: Date.now(),
            });
            if (h.mux === true) {
              c.channels = new Map();
              send(FRAME.ready, '');

              return;
            }
            if (h.forward !== undefined) {
              void Bun.connect({
                hostname: '127.0.0.1',
                port: h.forward,
                socket: {
                  open: (s) => {
                    c.socket = s;
                    send(FRAME.ready, '');
                  },
                  data: (_s, d) => {
                    ws.send(d);
                  },
                  close: () => {
                    ws.close(1000);
                  },
                  error: () => {
                    ws.close(1000);
                  },
                },
              }).catch(() => {
                ws.close(1000);
              });

              return;
            }
            const child = Bun.spawn(
              ['/bin/bash', ...(h.command === null ? ['-l'] : ['-c', h.command])],
              {
                env: o.env,
                cwd: o.cwd,
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: 'pipe',
              },
            );

            c.child = child;
            void (async () => {
              const pump = async (s: ReadableStream<Uint8Array>, type: number) => {
                for await (const chunk of s) send(type, chunk);
              };

              await Promise.all([pump(child.stdout, FRAME.out), pump(child.stderr, FRAME.err)]);
              const exit = await child.exited;

              // As in OpenSSH, a remote killed by a signal exits 255, as does a dropped connection.
              send(FRAME.exit, new Uint8Array([child.signalCode === null ? exit & 0xff : 255]));
              ws.close(1000);
            })();

            return;
          }
          if (type === FRAME.chan && c.channels !== undefined) {
            const channels = c.channels;
            const { ch, type: inner, body } = unchan(payload);
            const open = channels.get(ch);

            if (inner === FRAME.hello) {
              const want = ChannelDoc.parse(JSON.parse(new TextDecoder().decode(body)));

              ran.push({
                command: want.command,
                tty: want.tty,
                forward: null,
                channel: true,
                at: Date.now(),
              });
              const child = Bun.spawn(
                ['/bin/bash', ...(want.command === null ? ['-l'] : ['-c', want.command])],
                { env: o.env, cwd: o.cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
              );

              channels.set(ch, child);
              void (async () => {
                const pump = async (s: ReadableStream<Uint8Array>, t: number) => {
                  for await (const chunk of s) ws.send(chan(ch, t, chunk));
                };

                await Promise.all([pump(child.stdout, FRAME.out), pump(child.stderr, FRAME.err)]);
                const exit = await child.exited;

                channels.delete(ch);
                ws.send(
                  chan(
                    ch,
                    FRAME.exit,
                    new Uint8Array([child.signalCode === null ? exit & 0xff : 255]),
                  ),
                );
              })();
            } else if (inner === FRAME.input && open !== undefined) {
              if (body.length === 0) void open.stdin.end();
              else {
                void open.stdin.write(body);
                void open.stdin.flush();
              }
            } else if (inner === FRAME.close) open?.kill();

            return;
          }
          if (type === FRAME.input && c.child !== undefined) {
            if (payload.length === 0) void c.child.stdin.end();
            else {
              void c.child.stdin.write(payload);
              void c.child.stdin.flush();
            }
          }
        });
      },
      message: (ws, message) => {
        const bytes =
          typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message);
        const c = ws.data;

        if (c.hello?.forward !== undefined && c.socket !== undefined) c.socket.write(bytes);
        else c.feed(bytes);
      },
      close: (ws) => {
        live.delete(ws);
        clearTimeout(ws.data.timer);
        ws.data.child?.kill();
        for (const child of ws.data.channels?.values() ?? []) child.kill();
        ws.data.socket?.end();
      },
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    pushes: () => [...pushes],
    tunnels: () => [...tunnels],
    ran: () => [...ran],
    open: () => live.size,
    isDown: down,
    outage: (ms) => {
      downUntil = Date.now() + ms;
      for (const ws of [...live]) ws.terminate();
    },
    deny: (instance) => {
      denied.add(instance);
    },
    refuseTunnels: (status) => {
      refuseWith = status;
    },
    failPushes: (n) => {
      pushFailures = n;
    },
    stop: () => {
      for (const ws of [...live]) ws.terminate();
      void server.stop(true);
    },
  };
};
