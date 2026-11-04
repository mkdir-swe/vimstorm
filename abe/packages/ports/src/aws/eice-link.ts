/**
 * The Mac reaches a box over SSH through the org's EC2 Instance Connect Endpoint (#91, ADR
 * 0021): no public address, a fresh ed25519 key per connection (made in a private temporary
 * folder, removed once it may no longer be reused), pushed by abe's own tunnel client while the
 * tunnel opens. `run` / `follow` are `abe <argv>` there (`BoxLink`), `forward` a local port to a
 * port there, `attachLoop` the person's terminal there (`abe box attach`), each with the t50b
 * spike's ssh options; `shared` a short command as a channel on the box's one shared connection
 * (ssh ControlMaster, #93). IO only: which box and when is serve's and core's.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type Answered,
  type Box,
  type BoxLink,
  type Boxes,
  boxReachOfState,
  boxReachText,
  type Forwarded,
  type Ran,
  shellWord,
} from '@abe/core';
import { z } from 'zod';
import { type AwsCli, awsRunner } from './aws';
import { awsAuth, awsProfileKeys, boxAwsEnv, boxProfileOf, ec2BoxesFrom } from './boxes';
import { type Env, locate } from '../mac/locations';
import { pushedMark } from './eice-tunnel';
import { freeLocalPort } from '../mac/local-port';
import { type AwsKeys } from './sigv4';

/** Where a running box is: its instance and address, and the endpoint that reaches its VPC. */
export type BoxAddress = {
  box: string;
  instance: string;
  ip: string;
  region: string;
  endpoint: string;
  dns: string;
};

/** The t50b spike's ssh options: strict keepalives, no keystroke padding, only our key. */
export const SPIKE_SSH_OPTIONS = [
  'ServerAliveInterval=2',
  'ServerAliveCountMax=3',
  'TCPKeepAlive=no',
  'ConnectTimeout=5',
  // OpenSSH 9.5+ pads typing on a 20 ms clock; an older ssh skips the option it does not know.
  'IgnoreUnknown=ObscureKeystrokeTiming',
  'ObscureKeystrokeTiming=no',
  'IdentitiesOnly=yes',
] as const;

/** A key pushed less than this long ago is offered again (EC2 Instance Connect keeps it 60 s). */
export const KEY_REUSE_MS = 45_000;

/** How long a key's file stays: EC2 Instance Connect's 60 s, and a margin for a slow login. */
const KEY_LIFE_MS = 75_000;

/** The box's user (the box module's). */
const BOX_USER = 'ubuntu';

/** How long one `abe` on a box may run: a first `workspace up` builds an image. */
const RUN_TIMEOUT_MS = 30 * 60_000;

/** A forward that has had no connection this long gives up. */
const FORWARD_GIVE_UP_MS = 5 * 60_000;

/** A connection that lasted this long was up: a loop's back-off or give-up starts again at its drop. */
export const UP_MS = 10_000;

/**
 * Where an address read stays good: a box keeps its private address across stops. Only a running
 * box's is kept: EC2's state is read anew until it runs (#143: one read asleep was said again
 * after the box had woken).
 */
const ADDRESS_MS = 10 * 60_000;

/** The shared connections' policy (#93), in one table. */
export const MUX = {
  /** A master with no call on it for this long ends (ssh's ControlPersist). */
  persistSeconds: 600,
  /** How long a master may take to log in (its tunnel, the key's push, ssh's auth). */
  startMs: 60_000,
  /** How long a call waits for another to make the box's master before it goes on its own: a start and 15 s. */
  lockWaitMs: 60_000 + 15_000,
  /** The back-off: after a master could not be made, the box's calls go on their own this long. */
  failedMs: 60_000,
  /**
   * A master takes no new call this long before the endpoint cuts its tunnel at its cap (1 h
   * unless set): 10 min, or a fifth of a cap shorter than 50 min.
   */
  retireBeforeCapMs: 10 * 60_000,
  retireBeforeCapShare: 1 / 5,
  /** A control socket's path at most: macOS's 104 bytes less the `.XXXXXXXXXXXXXXXX` ssh binds first. */
  socketPathMax: 86,
} as const;

/** A file's text, '' when it cannot be read. */
const readText = (file: string) => {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
};

/** Whether process `pid` is still there (a signal 0 to it). */
const running = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (e) {
    // EPERM: there, someone else's
    return e instanceof Error && 'code' in e && e.code === 'EPERM';
  }
};

const Endpoints = z.object({
  InstanceConnectEndpoints: z.array(
    z.object({
      InstanceConnectEndpointId: z.string(),
      DnsName: z.string(),
      SubnetId: z.string().optional(),
    }),
  ),
});

const Exported = z.object({
  AccessKeyId: z.string().min(1),
  SecretAccessKey: z.string().min(1),
  SessionToken: z.string().optional(),
  Expiration: z.string().optional(),
});

const fail = (code: string, message: string): Answered<never> => ({
  ok: false,
  error: { code, message },
});

const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** An EC2 read that failed for no refusal's reason (the network, a slow CLI, an odd answer): trying again may mend it. */
export const mendable = (code: string): boolean =>
  code === 'box-unreachable' || code === 'aws-failed';

/**
 * Your box's address: `box` is one of your boxes by name, or by its instance id. Found through
 * `Boxes`, so only your own (its `abe:owner` your login) and with its codes (`no-box`, `aws-auth`,
 * `aws-refused`, `aws-failed`); the endpoint is its VPC's (one in its own subnet first). A box
 * EC2 does not say runs is `box-stopped`, in `boxReachText`'s words for its state.
 */
export const findBox = async (
  boxes: Boxes,
  aws: AwsCli,
  box: string,
  now: number,
): Promise<Answered<BoxAddress>> => {
  const mine = /^i-[0-9a-f]+$/.test(box)
    ? await boxes
        .list()
        .then((l): Answered<Box | null> =>
          l.ok ? { ok: true, data: l.data.find((b) => b.id === box) ?? null } : l,
        )
    : await boxes.status(box);

  if (!mine.ok) return mine;
  const one = mine.data;

  if (one === null) return fail('no-box', `you have no box ${box}: abe box list names yours`);
  const down = boxReachOfState(one.state, one.launchedAt ?? null);

  if (down !== undefined) return fail('box-stopped', boxReachText(box, down, now));
  if (one.privateIp === null || one.vpc === null)
    return fail('box-unreachable', `${box} has no private address (state ${one.state})`);
  const region = one.zone.replace(/[a-z]$/, '');
  const found = await aws([
    'ec2',
    'describe-instance-connect-endpoints',
    '--filters',
    `Name=vpc-id,Values=${one.vpc}`,
    'Name=state,Values=create-complete',
    ...(region === '' ? [] : ['--region', region]),
    '--output',
    'json',
  ]);

  if (!found.ok) return fail('box-unreachable', found.error.message);
  const endpoints = Endpoints.safeParse(json(found.data));

  if (!endpoints.success)
    return fail(
      'box-unreachable',
      'aws ec2 describe-instance-connect-endpoints: an answer abe does not read',
    );
  const list = endpoints.data.InstanceConnectEndpoints;
  const eice = list.find((e) => e.SubnetId === one.subnet) ?? list[0];

  if (eice === undefined)
    return fail(
      'no-endpoint',
      `no EC2 Instance Connect Endpoint in ${one.vpc} (infra/aws makes it)`,
    );

  return {
    ok: true,
    data: {
      box,
      instance: one.id,
      ip: one.privateIp,
      region,
      endpoint: eice.InstanceConnectEndpointId,
      dns: eice.DnsName,
    },
  };
};

/** The person's credentials (their profile's) as `aws configure export-credentials` reads them. */
export const exportedKeys = async (
  aws: AwsCli,
  profile: string | null = null,
  keys = false,
): Promise<Answered<{ keys: AwsKeys; expires: number | null }>> => {
  const out = await aws(['configure', 'export-credentials', '--format', 'process']);
  if (!out.ok) return awsAuth(out.error.message, profile, keys);
  const read = Exported.safeParse(json(out.data));

  if (!read.success)
    return {
      ok: false,
      error: {
        ...awsAuth('', profile, keys).error,
        message: 'aws configure export-credentials: an answer abe does not read',
      },
    };
  const c = read.data;

  return {
    ok: true,
    data: {
      keys: {
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretAccessKey,
        ...(c.SessionToken === undefined ? {} : { sessionToken: c.SessionToken }),
      },
      expires: c.Expiration === undefined ? null : Date.parse(c.Expiration),
    },
  };
};

export type EiceLinkOptions = {
  /** The person's environment: `AWS_PROFILE` and the rest `aws` and `ssh` run with. */
  env: Env;
  aws: AwsCli;
  /** How this `abe` is run (`selfArgv([])`): ssh's ProxyCommand is its `box tunnel`. */
  self: readonly string[];
  /** `$ABE_SSH`, else `ssh`. */
  ssh?: string;
  /** Your boxes: the one a connection goes to is found among them (yours only). */
  boxes: Boxes;
  /** The profile named in a refusal's sign-in command (null: none named). */
  profile?: string | null;
  /** That profile signs in with an IAM user's keys (`aws configure`). */
  keys?: boolean;
  /** Where each connection's key lives (default: a private temp folder of its own). */
  dir?: string;
  /** The boxes' host keys, each under its instance id, learnt on first connect (default: in `dir`). */
  knownHosts?: string;
  /** The endpoint's tunnel cut in seconds (`$ABE_BOX_TUNNEL_MAX_SECONDS`, checks only). */
  maxSeconds?: number;
  /** The folder (0700) of the boxes' shared connections' control sockets (#93); none: no sharing. */
  mux?: string;
  /** A line for the person (stderr): a shared connection that could not be made. */
  say: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/** A connection's key: `pushed` once its tunnel said the push succeeded (`made` stands for when). */
type Key = { dir: string; file: string; pub: string; made: number; pushed: boolean };

/** One ssh connection's argv and environment, ready to spawn. */
export type SshCall = { argv: string[]; env: Record<string, string>; status: string };

export type EiceLink = BoxLink & {
  /**
   * The ssh argv for one connection to `box`: `tty` for a terminal, `remote` its command words
   * (null: a login shell); `master`: the box's shared connection itself (ControlMaster, in the
   * background once logged in, its socket and its tunnel's status file there).
   */
  connection: (
    box: string,
    o: {
      tty: boolean;
      remote: readonly string[] | null;
      forward?: { local: number; remote: number };
      master?: { socket: string; status: string };
    },
  ) => Promise<Answered<SshCall>>;
  /**
   * The ssh argv for `remote` (no terminal) as a channel on `box`'s shared connection (#93): a
   * round trip on a live master, which needs no address, credentials or key; else a master made
   * first (one at a time per box), through the endpoint as any connection, its key fresh and
   * checked only at its login. A master that cannot be made leaves the call its own connection.
   */
  shared: (box: string, remote: readonly string[]) => Promise<Answered<SshCall>>;
  /** Forgets a box's address (after a failed connection: it may have moved). */
  forget: (box: string) => void;
  /** Removes every key this link made. */
  close: () => void;
};

const envOf = (env: Env) =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));

/** A free port on 127.0.0.1 (taken by the OS, then let go for ssh to bind). */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();

    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a !== null ? a.port : 0;

      s.close(() => {
        resolve(port);
      });
    });
  });

const takes = async (port: number) => {
  try {
    const s = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data: () => undefined } });

    s.end();

    return true;
  } catch {
    return false;
  }
};

export const eiceLink = (o: EiceLinkOptions): EiceLink => {
  const env = envOf(o.env);
  const ssh = o.ssh ?? 'ssh';
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'abe-box-'));
  const addresses = new Map<string, { at: number; address: BoxAddress }>();
  let creds: { keys: AwsKeys; expires: number | null } | undefined;
  /** Each box's key: a push lets a key in only on the instance it was pushed to (#67). */
  const boxKeys = new Map<string, Key>();
  let made = 0;

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (o.knownHosts !== undefined)
    mkdirSync(dirname(o.knownHosts), { recursive: true, mode: 0o700 });

  const address = async (box: string): Promise<Answered<BoxAddress>> => {
    const held = addresses.get(box);

    if (held !== undefined && o.now() - held.at < ADDRESS_MS)
      return { ok: true, data: held.address };
    const found = await findBox(o.boxes, o.aws, box, o.now());

    if (found.ok) addresses.set(box, { at: o.now(), address: found.data });

    return found;
  };

  const keys = async (): Promise<Answered<AwsKeys>> => {
    // Five minutes' margin: a tunnel signed now opens within its URL's 60 s.
    if (creds !== undefined && (creds.expires === null || creds.expires - o.now() > 5 * 60_000))
      return { ok: true, data: creds.keys };
    const read = await exportedKeys(o.aws, o.profile ?? null, o.keys ?? false);

    if (!read.ok) return read;
    creds = read.data;

    return { ok: true, data: read.data.keys };
  };

  /**
   * A key out of its folder once EC2 Instance Connect let go of it (60 s after its push, which
   * follows its making): every connection that offered it has logged in or failed by then. With
   * or without a key after it, so a serve that stays up keeps none.
   */
  const removeLater = (instance: string, k: Key) => {
    setTimeout(() => {
      if (boxKeys.get(instance) === k) boxKeys.delete(instance);
      rmSync(k.dir, { recursive: true, force: true });
    }, KEY_LIFE_MS).unref();
  };

  /**
   * The key to offer `instance` now, and whether this connection pushes it. A key is offered
   * again only to the box a tunnel pushed it to (the mark it leaves), timed from its making, which
   * is before its push; another box gets its own.
   */
  const keyNow = (instance: string): Answered<{ key: Key; push: boolean }> => {
    const now = o.now();
    const key = boxKeys.get(instance);

    if (key !== undefined && !key.pushed) key.pushed = existsSync(pushedMark(key.pub));
    if (key !== undefined && key.pushed && now - key.made < KEY_REUSE_MS)
      return { ok: true, data: { key, push: false } };
    made += 1;
    const kdir = join(dir, `k${made}`);

    mkdirSync(kdir, { recursive: true, mode: 0o700 });
    const file = join(kdir, 'id');
    const gen = Bun.spawnSync(
      ['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'abe-box', '-f', file],
      {
        env,
        stdin: 'ignore',
      },
    );

    if (gen.exitCode !== 0)
      return fail('ssh-keygen', gen.stderr.toString().trim() || 'ssh-keygen failed');
    const fresh = { dir: kdir, file, pub: `${file}.pub`, made: now, pushed: false };

    boxKeys.set(instance, fresh);
    removeLater(instance, fresh);

    return { ok: true, data: { key: fresh, push: true } };
  };

  const connection: EiceLink['connection'] = async (box, c) => {
    const where = await address(box);

    if (!where.ok) return where;
    const a = where.data;
    const signing = await keys();

    if (!signing.ok) return signing;
    const k = keyNow(a.instance);

    if (!k.ok) return k;
    const status =
      c.master?.status ?? join(dir, `status-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const tunnel = [
      ...o.self,
      'box',
      'tunnel',
      '--instance',
      a.instance,
      '--endpoint',
      a.endpoint,
      '--dns',
      a.dns,
      '--ip',
      a.ip,
      '--region',
      a.region,
      '--port',
      '22',
      ...(k.data.push ? ['--push', k.data.key.pub, '--user', BOX_USER] : []),
      ...(o.maxSeconds === undefined ? [] : ['--max-seconds', String(o.maxSeconds)]),
      '--status',
      status,
    ]
      .map(shellWord)
      .join(' ')
      // ssh reads % in a ProxyCommand as its own tokens.
      .replaceAll('%', '%%');
    const s = signing.data;
    const argv = [
      ssh,
      '-F',
      '/dev/null',
      c.tty ? '-tt' : '-T',
      ...(c.master === undefined
        ? []
        : ['-M', '-N', '-f', '-S', c.master.socket, '-o', `ControlPersist=${MUX.persistSeconds}`]),
      ...(c.forward === undefined
        ? []
        : [
            '-N',
            '-L',
            `127.0.0.1:${c.forward.local}:127.0.0.1:${c.forward.remote}`,
            '-o',
            'ExitOnForwardFailure=yes',
          ]),
      '-i',
      k.data.key.file,
      ...SPIKE_SSH_OPTIONS.flatMap((opt) => ['-o', opt]),
      '-o',
      'IdentityAgent=none',
      '-o',
      'BatchMode=yes',
      '-o',
      'LogLevel=ERROR',
      '-o',
      `HostKeyAlias=${a.instance}`,
      '-o',
      `UserKnownHostsFile=${o.knownHosts ?? join(dir, 'known_hosts')}`,
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `ProxyCommand=${tunnel}`,
      `${BOX_USER}@${a.instance}`,
      ...(c.remote ?? []),
    ];

    return {
      ok: true,
      data: {
        argv,
        env: {
          // Only these keys sign: a session token of the person's own shell never rides along.
          ...Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'AWS_SESSION_TOKEN')),
          AWS_ACCESS_KEY_ID: s.accessKeyId,
          AWS_SECRET_ACCESS_KEY: s.secretAccessKey,
          ...(s.sessionToken === undefined ? {} : { AWS_SESSION_TOKEN: s.sessionToken }),
        },
        status,
      },
    };
  };

  /** A master this old takes no new call: the endpoint cuts its tunnel at its cap (1 h unless set). */
  const capMs = (o.maxSeconds ?? 3600) * 1000;
  const retireMs = capMs - Math.min(MUX.retireBeforeCapMs, capMs * MUX.retireBeforeCapShare);
  const tagOf = (box: string) => createHash('sha256').update(box).digest('hex').slice(0, 8);

  /** Asks the master at `socket` whether it is up (`ssh -O check`: on this Mac only, no network). */
  const alive = (socket: string) =>
    Bun.spawnSync([ssh, '-F', '/dev/null', '-S', socket, '-O', 'check', 'abe-box'], {
      env,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }).exitCode === 0;

  const forgetMaster = (socket: string) => {
    for (const f of [socket, `${socket}.status`, `${socket}.log`]) rmSync(f, { force: true });
  };

  /**
   * The box's live master's socket, newest first. One that is gone (its socket left) or near its
   * tunnel's cap is taken out of the folder: no new call finds it, and a live one ends after
   * ControlPersist with no channel on it.
   */
  const liveMaster = (mux: string, box: string): string | undefined => {
    const tag = tagOf(box);
    const found = existsSync(mux)
      ? readdirSync(mux)
          .map((f) => /^([0-9a-f]{8})\.([0-9a-z]+)$/.exec(f))
          .filter((m): m is RegExpExecArray => m?.[1] === tag)
          .map((m) => ({ path: join(mux, m[0]), at: parseInt(m[2] ?? '0', 36) * 1000 }))
          .sort((a, b) => b.at - a.at)
      : [];

    for (const m of found) {
      if (o.now() - m.at < retireMs && alive(m.path)) return m.path;
      forgetMaster(m.path);
    }

    return undefined;
  };

  /** `remote` as a channel on the master at `socket`: its socket only, no key, no tunnel. */
  const onMaster = (socket: string, remote: readonly string[]): Answered<SshCall> => ({
    ok: true,
    data: {
      argv: [
        ssh,
        '-F',
        '/dev/null',
        '-T',
        '-S',
        socket,
        '-o',
        'ControlMaster=no',
        // A master gone between the check and the call: ssh fails at once instead of connecting
        // by itself, and the attach loop's next try makes a new one.
        '-o',
        'ProxyCommand=false',
        '-o',
        'BatchMode=yes',
        '-o',
        'LogLevel=ERROR',
        'abe-box',
        ...remote,
      ],
      env,
      status: '',
    },
  });

  /**
   * Takes the box's master lock (a file naming its holder's pid; one whose holder is gone is
   * taken over): its release, or undefined when it could not be had in time (the holder slow or
   * the folder unwritable), and the call then goes on its own connection.
   */
  const lockMaster = async (mux: string, box: string): Promise<(() => void) | undefined> => {
    const lock = join(mux, `${tagOf(box)}-starting`);
    const mine = String(process.pid);

    for (const until = o.now() + MUX.lockWaitMs; o.now() < until;) {
      try {
        writeFileSync(lock, mine, { flag: 'wx', mode: 0o600 });

        return () => {
          if (readText(lock) === mine) rmSync(lock, { force: true });
        };
      } catch (e) {
        if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) return undefined;
      }
      const holder = Number(readText(lock));

      if (Number.isInteger(holder) && holder > 0 && !running(holder)) rmSync(lock, { force: true });
      else await o.sleep(100);
    }

    return undefined;
  };

  /** A box whose master could not be made lately: its calls go on their own connections a while. */
  const noMux = (mux: string, box: string) => join(mux, `${tagOf(box)}-failed`);
  const failedLately = (mux: string, box: string) => {
    try {
      return o.now() - statSync(noMux(mux, box)).mtimeMs < MUX.failedMs;
    } catch {
      return false;
    }
  };

  /**
   * A new master for `box`: logged in through the endpoint as any connection (its key fresh, or
   * one pushed less than KEY_REUSE_MS ago), then in the background with ControlPersist. Its stderr
   * (and its tunnel's) goes to a file: the tunnel lives on with the master, so a pipe would never end.
   */
  const startMaster = async (mux: string, box: string): Promise<Answered<string>> => {
    const socket = join(mux, `${tagOf(box)}.${Math.floor(o.now() / 1000).toString(36)}`);

    if (socket.length > MUX.socketPathMax)
      return fail('master-failed', `the control socket's path is too long: ${socket}`);
    forgetMaster(socket);
    const status = `${socket}.status`;
    const call = await connection(box, { tty: false, remote: null, master: { socket, status } });

    if (!call.ok) return call;
    const log = `${socket}.log`;
    const fd = openSync(log, 'w', 0o600);
    const child = (() => {
      try {
        return Bun.spawn(call.data.argv, {
          env: call.data.env,
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: fd,
        });
      } finally {
        closeSync(fd);
      }
    })();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, MUX.startMs);
    const exit = await child.exited.finally(() => {
      clearTimeout(timer);
    });

    if (exit === 0 && alive(socket)) return { ok: true, data: socket };
    const fatal = fatalOf(status);
    const said = readText(log);

    forgetMaster(socket);
    if (exit === 255) addresses.delete(box);
    if (fatal !== undefined) return fail('tunnel-refused', fatal);

    return fail('master-failed', said || `ssh exited ${exit}`);
  };

  const shared: EiceLink['shared'] = async (box, remote) => {
    const mux = o.mux;

    if (mux === undefined) return connection(box, { tty: false, remote });
    const live = liveMaster(mux, box);

    if (live !== undefined) return onMaster(live, remote);
    const own = () => connection(box, { tty: false, remote });

    if (failedLately(mux, box)) return own();
    mkdirSync(mux, { recursive: true, mode: 0o700 });
    chmodSync(mux, 0o700);
    const release = await lockMaster(mux, box);

    if (release === undefined) return own();
    try {
      // Another call may have made it while this one waited.
      const made = liveMaster(mux, box) ?? (await startMaster(mux, box));

      if (typeof made === 'string') return onMaster(made, remote);
      if (made.ok) return onMaster(made.data, remote);
      if (made.error.code !== 'master-failed') return made;
      // Its ssh failed or its socket's path is too long (not a refusal): this call and the next
      // while it lasts go on their own connections, the loop's as ever, instead of each paying a
      // master's try first. Said once, as the back-off starts.
      writeFileSync(noMux(mux, box), made.error.message, { mode: 0o600 });
      o.say(
        `abe: no shared connection to ${box} (${made.error.message.trim().split('\n')[0] ?? ''}); its calls go on their own for ${String(MUX.failedMs / 1000)} s`,
      );

      return await own();
    } finally {
      release();
    }
  };

  const abeWords = (argv: readonly string[]) =>
    // On the box its serve is the abe-serve unit's: a client there never starts one.
    ['abe', ...argv, '--no-start'].map(shellWord);

  const unreachable = (message: string): Ran => ({ exit: 255, stdout: '', stderr: `${message}\n` });

  return {
    connection,
    shared,
    forget: (box) => {
      addresses.delete(box);
    },
    close: () => {
      rmSync(dir, { recursive: true, force: true });
    },
    run: async (box, argv) => {
      const call = await connection(box, { tty: false, remote: abeWords(argv) });

      if (!call.ok) return unreachable(call.error.message);
      const child = Bun.spawn(call.data.argv, {
        env: call.data.env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, RUN_TIMEOUT_MS);
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).finally(() => {
        clearTimeout(timer);
      });

      if (exit === 255) addresses.delete(box);

      return { exit, stdout, stderr };
    },
    follow: (box, argv, onLine) => {
      const asked = { stop: false };
      let kill: () => void = () => {
        asked.stop = true;
      };
      const ended = (async () => {
        const call = await connection(box, { tty: false, remote: abeWords(argv) });

        if (!call.ok || asked.stop) return 255;
        const child = Bun.spawn(call.data.argv, {
          env: call.data.env,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'ignore',
        });

        kill = () => {
          child.kill();
        };
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
        const exit = await child.exited;

        if (exit === 255) addresses.delete(box);

        return exit;
      })();

      return {
        stop: () => {
          kill();
        },
        ended,
      };
    },
    attach: (box, argv) => [...o.self, 'box', 'attach', box, '--', 'abe', ...argv, '--no-start'],
    forward: async (box, port, wanted) => {
      // The first wanted port nothing holds here (#16); none wanted: any the OS gives.
      const chosen = wanted === undefined ? await freePort() : await freeLocalPort(wanted);

      if (chosen === undefined)
        return fail(
          'port-taken',
          `localhost:${wanted?.map(String).join(', ') ?? ''} taken on this machine`,
        );
      const local = chosen;
      const first = await connection(box, {
        tty: false,
        remote: null,
        forward: { local, remote: port },
      });

      if (!first.ok) return first;
      const asked = { stop: false };
      let child: ReturnType<typeof Bun.spawn> | undefined;
      const start = (call: SshCall) => {
        child = Bun.spawn(call.argv, {
          env: call.env,
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'pipe',
        });

        return child;
      };
      /** Why the loop stopped mending the forward ('' once asked to stop). */
      const loop = (async (): Promise<string> => {
        let call: Answered<SshCall> = first;
        let lostAt: number | undefined;
        let fails = 0;

        for (;;) {
          if (call.ok) {
            const began = o.now();
            const ran = start(call.data);
            const err = ran.stderr instanceof ReadableStream ? new Response(ran.stderr).text() : '';
            const exit = await ran.exited;
            const said = (await err).trim();

            if (asked.stop) return '';
            const why = fatalOf(call.data.status);

            if (why !== undefined || exit !== 255) return why ?? (said || `ssh exited ${exit}`);
            if (o.now() - began >= UP_MS) {
              lostAt = undefined;
              fails = 0;
            }
          } else if (!mendable(call.error.code)) return call.error.message;
          lostAt ??= o.now();
          if (o.now() - lostAt >= FORWARD_GIVE_UP_MS)
            return `no connection to ${box} for ${Math.round(FORWARD_GIVE_UP_MS / 1000)} s, giving up`;
          fails += 1;
          // The address read again only once a few tries failed (it may have moved).
          if (fails % 3 === 0) addresses.delete(box);
          // Half a second, then twice as long each time, at most 4 s.
          await o.sleep(Math.min(500 * 2 ** (fails - 1), 4_000));
          if (asked.stop) return '';
          call = await connection(box, {
            tty: false,
            remote: null,
            forward: { local, remote: port },
          });
        }
      })();
      const stop = () => {
        asked.stop = true;
        child?.kill();
      };
      const forwarded: Forwarded = { port: local, stop, ended: loop };

      // Up once the port takes a connection (ssh binds it after logging in), or why not.
      for (const until = o.now() + 30_000; o.now() < until;) {
        if (await takes(local)) return { ok: true, data: forwarded };
        const over = await Promise.race([loop, o.sleep(100).then(() => undefined)]);

        if (over !== undefined)
          return fail('forward-failed', over || `ssh gave no forward of ${box}:${port}`);
      }
      stop();

      return fail('forward-failed', `${box}:${port} was not forwarded within 30 s`);
    },
  };
};

/** What the tunnel wrote to its status file: why it can never open (and the file removed). */
export const fatalOf = (status: string): string | undefined => {
  try {
    const why = readFileSync(status, 'utf8').trim();

    rmSync(status, { force: true });

    return why === '' ? undefined : why;
  } catch {
    return undefined;
  }
};

/**
 * The link from the environment: `aws` on `boxAwsEnv` (`$ABE_BOX_PROFILE`, else `$AWS_PROFILE`),
 * your boxes (`ec2BoxesFrom`: yours by `$ABE_OWNER`, else gh's login), `$ABE_SSH` for `ssh`,
 * `$ABE_BOX_TUNNEL_MAX_SECONDS` for a short tunnel cap (the cap check); the shared connections'
 * control sockets in `<state>/mux`.
 */
export const eiceLinkFrom = (
  env: Env,
  self: readonly string[],
  boxes: Boxes = ec2BoxesFrom(env),
): EiceLink => {
  const awsEnv = boxAwsEnv(env);
  const max = Number(env.ABE_BOX_TUNNEL_MAX_SECONDS ?? '');

  return eiceLink({
    env: awsEnv,
    aws: awsRunner(awsEnv),
    boxes,
    profile: boxProfileOf(env),
    keys: awsProfileKeys(env, env.HOME ?? homedir(), boxProfileOf(env)),
    self,
    knownHosts: join(locate(env, homedir()).stateDir, 'box-known-hosts'),
    mux: join(locate(env, homedir()).stateDir, 'mux'),
    ...((env.ABE_SSH ?? '') === '' ? {} : { ssh: env.ABE_SSH ?? 'ssh' }),
    ...(Number.isInteger(max) && max > 0 ? { maxSeconds: max } : {}),
    say: (line) => {
      process.stderr.write(`${line}\n`);
    },
    now: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
  });
};
