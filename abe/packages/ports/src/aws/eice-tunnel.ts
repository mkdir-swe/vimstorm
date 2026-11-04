/**
 * abe's own EC2 Instance Connect Endpoint tunnel (#91, ADR 0021): what `ssh` runs as its
 * `ProxyCommand` (`abe box tunnel …`). It opens `wss://<endpoint>/openTunnel`, signed with SigV4
 * on the person's SSO credentials, and pipes stdin and stdout through it as binary frames. It
 * waits on input, never on a timer: the stock `aws ec2-instance-connect open-tunnel` looks at
 * stdin every 50 ms, which the t50b spike measured as up to 50 ms on every key.
 *
 * With a key to push it sends it (`SendSSHPublicKey`) while the tunnel opens, and pipes nothing
 * before both are done, so `sshd` asks for the key only once it is there. A refusal that trying
 * again cannot mend (no right to the box, the box gone or stopped, the login expired) is written
 * to the status file, so the attach loop around `ssh` stops instead of trying again.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { type Env } from '../mac/locations';
import { type AwsKeys, presignUrl, signedHeaders } from './sigv4';

export type TunnelTarget = {
  /** The box's instance. */
  instance: string;
  /** The Instance Connect Endpoint and its DNS name. */
  endpoint: string;
  dns: string;
  /** The box's private address and the port the tunnel reaches there. */
  ip: string;
  port: number;
  region: string;
  /** The endpoint's cut (1 to 3600 s; AWS's default 3600). */
  maxSeconds?: number;
};

export type TunnelOptions = {
  target: TunnelTarget;
  keys: AwsKeys;
  /** A public key to push for the box's user first (valid 60 s on the box). */
  push?: { user: string; publicKey: string };
  /** Told once the key's push succeeded (the link may offer the key again then). */
  pushed?: () => void;
  now: () => Date;
  /** Both requests go here in place of AWS (`$ABE_EICE_URL`, a fake endpoint: `http://127.0.0.1:<port>`). */
  base?: string;
  stdin: ReadableStream<Uint8Array>;
  write: (chunk: Uint8Array) => void;
  /** Why the tunnel can never open, for the attach loop (`--status`). */
  fatal: (message: string) => void;
  /** A line for `ssh`'s stderr. */
  log: (message: string) => void;
};

/** The endpoint's largest frame (the AWS CLI's). */
const MAX_FRAME = 65_000;

/** EC2 Instance Connect's error types that trying again cannot mend. */
const FINAL = [
  'AccessDenied',
  'AuthException',
  'EC2InstanceNotFoundException',
  'EC2InstanceStateInvalidException',
  'InvalidArgsException',
  'ExpiredToken',
  'UnrecognizedClient',
  'InvalidClientTokenId',
];

type Push = { ok: true } | { ok: false; final: boolean; message: string };

const ErrorDoc = (body: string): { type: string; message: string } => {
  try {
    const doc: unknown = JSON.parse(body);

    if (typeof doc === 'object' && doc !== null) {
      const type = '__type' in doc && typeof doc.__type === 'string' ? doc.__type : '';
      const upper = 'Message' in doc && typeof doc.Message === 'string' ? doc.Message : undefined;
      const lower = 'message' in doc && typeof doc.message === 'string' ? doc.message : undefined;
      const said = upper ?? lower ?? body;

      return { type: type.split('#').pop() ?? type, message: said };
    }
  } catch {
    // not JSON: the body as it is
  }

  return { type: '', message: body.trim() };
};

const loginHint = (type: string, message: string) =>
  /Expired|UnrecognizedClient|InvalidClientTokenId/.test(type)
    ? `${message} (your AWS login: aws sso login)`
    : message;

/** `SendSSHPublicKey`: the key for `user` on the box for the next 60 s. */
export const pushKey = async (
  o: Pick<TunnelOptions, 'target' | 'keys' | 'now' | 'base'>,
  push: { user: string; publicKey: string },
): Promise<Push> => {
  const url = new URL(o.base ?? `https://ec2-instance-connect.${o.target.region}.amazonaws.com/`);
  const body = JSON.stringify({
    InstanceId: o.target.instance,
    InstanceOSUser: push.user,
    SSHPublicKey: push.publicKey,
  });
  const headers = signedHeaders(
    {
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'AWSEC2InstanceConnectService.SendSSHPublicKey',
      },
      body,
    },
    { service: 'ec2-instance-connect', region: o.target.region, keys: o.keys, now: o.now() },
  );

  try {
    const res = await fetch(url, { method: 'POST', headers, body });
    const text = await res.text();

    if (res.ok) return { ok: true };
    const { type, message } = ErrorDoc(text);
    const final = FINAL.some((f) => type.startsWith(f)) || res.status === 403;

    return {
      ok: false,
      final,
      message: `send-ssh-public-key: ${loginHint(type, message || `HTTP ${res.status}`)}`,
    };
  } catch (err) {
    return { ok: false, final: false, message: `send-ssh-public-key: ${String(err)}` };
  }
};

/** The signed `openTunnel` URL, valid 60 s as the AWS CLI makes it. */
export const tunnelUrl = (o: Pick<TunnelOptions, 'target' | 'keys' | 'now' | 'base'>): string => {
  const t = o.target;
  const base =
    o.base === undefined ? `wss://${t.dns}` : o.base.replace(/^http/, 'ws').replace(/\/$/, '');
  const url = new URL(`${base}/openTunnel`);

  url.searchParams.set('instanceConnectEndpointId', t.endpoint);
  url.searchParams.set('remotePort', String(t.port));
  url.searchParams.set('privateIpAddress', t.ip);
  if (t.maxSeconds !== undefined) url.searchParams.set('maxTunnelDuration', String(t.maxSeconds));

  return presignUrl(
    url,
    { service: 'ec2-instance-connect', region: t.region, keys: o.keys, now: o.now() },
    60,
  );
};

/**
 * The status a refused handshake was answered with, read from Bun's error text (`… failed:
 * Expected 101 status code: 401`). Only the number is kept: the text holds the signed URL, its
 * session token too. (Asking the URL again over plain HTTPS tells nothing: the endpoint answers
 * every GET that is not a WebSocket with 400 `InvalidWebsocketRequest`, signed right or not.)
 */
export const handshakeStatus = (error: string): number | undefined => {
  const status = /Expected 101 status code: (\d{3})/.exec(error)?.[1];

  return status === undefined ? undefined : Number(status);
};

/** A refused handshake in words fit for a log: 401 / 403 is final (the login, the rights). */
const refusal = (status: number | undefined): { final: boolean; message: string } => {
  if (status === undefined)
    return { final: false, message: 'open-tunnel: handshake failed (no answer)' };
  const hints: Record<number, string> = {
    401: ' (the signature or your AWS login: aws sso login)',
    403: ' (no right to open a tunnel to this box)',
  };
  const hint = hints[status] ?? '';

  return {
    final: status === 401 || status === 403,
    message: `open-tunnel: handshake refused (HTTP ${status})${hint}`,
  };
};

type Opened = { ok: true; ws: WebSocket } | { ok: false; final: boolean; message: string };

const errorText = (e: Event) => (e instanceof ErrorEvent ? e.message : '');

const open = (
  signed: string,
  write: (chunk: Uint8Array) => void,
  closed: (c: CloseEvent) => void,
) =>
  new Promise<Opened>((resolve) => {
    const ws = new WebSocket(signed);
    let up = false;
    let status: number | undefined;

    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      up = true;
      resolve({ ok: true, ws });
    };
    ws.onmessage = (m: MessageEvent<unknown>) => {
      if (m.data instanceof ArrayBuffer) write(new Uint8Array(m.data));
      // The endpoint sends only binary frames; text is the AWS CLI's "invalid data" too.
      else ws.close(1002, 'text frame');
    };
    ws.onerror = (e) => {
      if (up) return;
      status ??= handshakeStatus(errorText(e));
      resolve({ ok: false, ...refusal(status) });
    };
    ws.onclose = (c) => {
      // Before it was up: the error said why (a second resolve is a no-op).
      if (!up) resolve({ ok: false, ...refusal(status) });
      else closed(c);
    };
  });

/** After ssh closed its side, how long the endpoint gets to close the tunnel before it is cut. */
const CLOSE_WAIT_MS = 2_000;

/** Runs one tunnel to its end: its exit for `ssh` (0 when it closed cleanly). */
export const runTunnel = async (o: TunnelOptions): Promise<number> => {
  /** How the endpoint closed the tunnel, once it did. */
  const end: { close: CloseEvent | undefined } = { close: undefined };
  let ended: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const signed = tunnelUrl(o);
  const [pushed, opened] = await Promise.all([
    o.push === undefined ? Promise.resolve<Push>({ ok: true }) : pushKey(o, o.push),
    open(signed, o.write, (c) => {
      end.close = c;
      ended();
    }),
  ]);
  if (o.push !== undefined && pushed.ok) o.pushed?.();
  const failed = (() => {
    if (!pushed.ok) return pushed;
    if (!opened.ok) return opened;

    return undefined;
  })();

  if (failed !== undefined) {
    if (opened.ok) opened.ws.close(1000);
    o.log(failed.message);
    if (failed.final) o.fatal(failed.message);

    return 1;
  }
  if (!opened.ok) return 1;
  const ws = opened.ws;
  const reader = o.stdin.getReader();

  void (async () => {
    for (;;) {
      const next = await reader.read().catch(() => ({ done: true as const, value: undefined }));

      if (next.done || end.close !== undefined) break;
      for (let at = 0; at < next.value.length; at += MAX_FRAME)
        ws.send(next.value.subarray(at, at + MAX_FRAME));
    }
    // ssh closed its side: the tunnel is done, and over a dead path no close ever comes back.
    if (end.close !== undefined) return;
    ws.close(1000);
    setTimeout(() => {
      ws.terminate();
      ended();
    }, CLOSE_WAIT_MS).unref();
  })();
  await done;
  void reader.cancel().catch(() => undefined);
  const c = end.close;

  if (c === undefined || c.code === 1000) return 0;
  o.log(`open-tunnel: closed${c.reason === '' ? ` (${c.code})` : `: ${c.reason}`}`);

  return 1;
};

/** `abe box tunnel`'s words: `--instance --endpoint --dns --ip --region [--port] [--push <file> --user] [--max-seconds] [--status <file>]`. */
export type TunnelArgs = {
  target: TunnelTarget;
  push?: { file: string; user: string };
  status?: string;
};

export const tunnelArgs = (argv: readonly string[]): TunnelArgs | string => {
  const got = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? '';
    const value = argv[i + 1];

    if (!flag.startsWith('--') || value === undefined) return `bad argument ${flag}`;
    got.set(flag.slice(2), value);
  }
  const need = (k: string) => got.get(k);
  const [instance, endpoint, dns, ip, region] = ['instance', 'endpoint', 'dns', 'ip', 'region'].map(
    need,
  );

  if (
    instance === undefined ||
    endpoint === undefined ||
    dns === undefined ||
    ip === undefined ||
    region === undefined
  )
    return 'needs --instance --endpoint --dns --ip --region';
  const portText = got.get('port') ?? '22';
  const port = Number(portText);
  const max = got.get('max-seconds');
  const file = got.get('push');
  const status = got.get('status');

  if (!Number.isInteger(port) || port < 1 || port > 65_535) return `bad --port ${portText}`;
  if (max !== undefined && !(Number.isInteger(Number(max)) && Number(max) > 0))
    return `bad --max-seconds ${max}`;

  return {
    target: {
      instance,
      endpoint,
      dns,
      ip,
      region,
      port,
      ...(max === undefined ? {} : { maxSeconds: Number(max) }),
    },
    ...(file === undefined ? {} : { push: { file, user: got.get('user') ?? 'ubuntu' } }),
    ...(status === undefined ? {} : { status }),
  };
};

/** The file the tunnel leaves beside a pushed public key once its push succeeded. */
export const pushedMark = (publicKeyFile: string): string => `${publicKeyFile}.pushed`;

/** The keys `abe box tunnel` signs with: the attach's, handed down through `ssh`'s environment. */
export const keysFromEnv = (env: Env): AwsKeys | undefined => {
  const id = env.AWS_ACCESS_KEY_ID ?? '';
  const secret = env.AWS_SECRET_ACCESS_KEY ?? '';
  const token = env.AWS_SESSION_TOKEN ?? '';

  if (id === '' || secret === '') return undefined;

  return {
    accessKeyId: id,
    secretAccessKey: secret,
    ...(token === '' ? {} : { sessionToken: token }),
  };
};

/**
 * `$ABE_EICE_URL` when it is a fake endpoint on this machine (`http(s)://127.0.0.1[:port]` or
 * `localhost`), else undefined: the shipped binary signs `SendSSHPublicKey` with the person's
 * keys and session token, which must never go to another host.
 */
export const eiceBase = (text: string): string | undefined => {
  if (!URL.canParse(text)) return undefined;
  const url = new URL(text);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  const web = url.protocol === 'http:' || url.protocol === 'https:';

  return web && loopback && url.username === '' && url.password === '' ? text : undefined;
};

/** `abe box tunnel <words>` (ssh's ProxyCommand) on this process's stdio: its exit. */
export const tunnelMain = async (argv: readonly string[], env: Env): Promise<number> => {
  const log = (message: string) => process.stderr.write(`abe box tunnel: ${message}\n`);
  const args = tunnelArgs(argv);

  if (typeof args === 'string') {
    log(args);

    return 2;
  }
  const keys = keysFromEnv(env);
  const fatal = (message: string) => {
    if (args.status !== undefined) writeFileSync(args.status, `${message}\n`, { mode: 0o600 });
  };

  if (keys === undefined) {
    const why = 'no AWS credentials in its environment (abe box attach hands them down)';

    log(why);
    fatal(why);

    return 1;
  }
  const given = env.ABE_EICE_URL ?? '';
  const base = given === '' ? undefined : eiceBase(given);

  if (given !== '' && base === undefined) {
    const why = `ABE_EICE_URL must be http(s)://127.0.0.1 or localhost (a fake endpoint), not ${given}`;

    log(why);
    fatal(why);

    return 1;
  }
  const out = Bun.stdout.writer();
  const exit = await runTunnel({
    target: args.target,
    keys,
    ...(args.push === undefined
      ? {}
      : {
          push: { user: args.push.user, publicKey: readFileSync(args.push.file, 'utf8').trim() },
          pushed: () => {
            if (args.push !== undefined)
              writeFileSync(pushedMark(args.push.file), '', { mode: 0o600 });
          },
        }),
    now: () => new Date(),
    ...(base === undefined ? {} : { base }),
    stdin: Bun.stdin.stream(),
    write: (chunk) => {
      void out.write(chunk);
      void out.flush();
    },
    fatal,
    log,
  });

  await out.end();

  return exit;
};
