/**
 * `abe box attach` / `abe box forward` at the CLI seam (#91): the real `abe` and its real tunnel
 * client (`abe box tunnel` as ssh's ProxyCommand), a fake `ssh` and a fake EC2 Instance Connect
 * Endpoint with a box behind it. The fake checks SigV4 as AWS does and lets a key in only once it
 * was pushed; a test cuts the network or the tunnel's time cap.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BoxForwardData, readEnvelope, WatchFrame } from '@abe/core';
import { eiceLinkFrom } from '@abe/ports';
import { type BoxFront } from './boxes';
import { onBoxAnswer } from './on-box';
import {
  type Cli,
  cli,
  FAKE_KEYS,
  fakeAws,
  type FakeAws,
  fakeGh,
  type FakeGh,
  ghUser,
  type FakeEice,
  fakeEice,
  fakeSsh,
  type FakeSsh,
  until,
} from '@abe/testing';

const INSTANCE = 'i-0fa4e0000000000b1';
const IP = '10.9.0.17';
/** Another box of the same owner behind the same endpoint. */
const OTHER = { instance: 'i-0fa4e0000000000b2', ip: '10.9.0.18', name: 'demo-shop-8' };

/** A box as EC2 lists it: `owner`'s `demo-shop-7`. */
const instance = (state: string, owner = 'octocat', id = INSTANCE) => ({
  InstanceId: id,
  InstanceType: 'm8g.large',
  State: { Name: state },
  PrivateIpAddress: IP,
  VpcId: 'vpc-0fake',
  SubnetId: 'subnet-0fake',
  Placement: { AvailabilityZone: 'eu-west-1a' },
  Tags: [
    { Key: 'abe:box', Value: 'demo-shop-7' },
    { Key: 'abe:owner', Value: owner },
  ],
});

const instances = (state: string, more: readonly ReturnType<typeof instance>[] = []) => ({
  Reservations: [{ Instances: [...more, instance(state)] }],
});

const AWS = (state = 'running', more: readonly ReturnType<typeof instance>[] = []) =>
  [
    [
      'describe-instance-connect-endpoints',
      {
        json: {
          InstanceConnectEndpoints: [
            {
              InstanceConnectEndpointId: 'eice-0fake',
              DnsName: 'eice-0fake.example',
              SubnetId: 'subnet-0fake',
            },
          ],
        },
      },
    ],
    ['describe-instances', { json: instances(state, more) }],
    [
      'export-credentials',
      {
        json: {
          Version: 1,
          AccessKeyId: FAKE_KEYS.accessKeyId,
          SecretAccessKey: FAKE_KEYS.secretAccessKey,
          SessionToken: FAKE_KEYS.sessionToken,
          Expiration: '2099-01-01T00:00:00+00:00',
        },
      },
    ],
  ] as const;

let box: string;
let aws: FakeAws;
let gh: FakeGh;
let eice: FakeEice;
let ssh: FakeSsh;
let abe: Cli;
// The Mac: who you are is gh's login (no $ABE_OWNER, which only a box is given).
const env = (more: Record<string, string> = {}) => ({
  PATH: `${gh.dir}:${aws.path}`,
  ABE_SSH: ssh.bin,
  ABE_EICE_URL: eice.url,
  AWS_PROFILE: 'abe-tooling',
  ...more,
});

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'eice-box-'));
  // The box's own abe: `session attach` holds the terminal as tmux would; `status` answers.
  writeFileSync(
    join(box, 'abe'),
    [
      '#!/bin/bash',
      'case "$1 $2" in',
      '  "session attach") echo "attached $3 ($*)"; exec sleep 60;;',
      '  "status --json") echo \'{"ok":true,"data":{"on":"box"}}\';;',
      // Its events file, from after --since, then as they come.
      '  "watch --since"|"watch --json") since=0; [ "$2" = --since ] && since=$3;',
      '    tail -n +1 -f "$HOME/events.jsonl" | while read -r l; do',
      '      n=$(echo "$l" | sed \'s/.*"seq":\\([0-9]*\\).*/\\1/\'); [ "$n" -gt "$since" ] && echo "$l"; done;;',
      '  *) echo "box abe $*";;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(join(box, 'events.jsonl'), '');
  aws = fakeAws(AWS());
  gh = fakeGh([['api user', { json: ghUser('octocat') }]]);
  eice = fakeEice({
    instance: INSTANCE,
    ip: IP,
    also: [{ instance: OTHER.instance, ip: OTHER.ip }],
    env: { PATH: `${box}:/usr/bin:/bin`, HOME: box },
    cwd: box,
  });
  ssh = fakeSsh();
  abe = cli({ env: env() });
});

afterEach(() => {
  aws.answer(AWS());
});

afterAll(async () => {
  eice.stop();
  await abe.close();
});

describe('abe box attach -- <argv>: a command on the box', () => {
  test("runs it over the endpoint with a fresh key, the spike's ssh options and its exit", async () => {
    const before = eice.pushes().length;
    const out = await abe.run(
      'box',
      'attach',
      'demo-shop-7',
      '--',
      'sh',
      '-c',
      "echo hi 'there'; exit 7",
    );

    expect(out.stdout).toBe('hi there\n');
    expect(out.exit).toBe(7);
    const argv = ssh.calls().at(-1) ?? [];

    expect(argv).toContain(`ubuntu@${INSTANCE}`);
    expect(argv).toContain('-T');
    for (const opt of [
      'ServerAliveInterval=2',
      'ServerAliveCountMax=3',
      'TCPKeepAlive=no',
      'ConnectTimeout=5',
      'ObscureKeystrokeTiming=no',
      'IdentitiesOnly=yes',
    ])
      expect(argv).toContain(opt);
    expect(argv.find((a) => a.startsWith('ProxyCommand='))).toContain("'box' 'tunnel'");
    // The credentials go through the environment only, never a word of a command line.
    expect(argv.join(' ')).not.toContain(FAKE_KEYS.secretAccessKey);
    expect(eice.pushes().slice(before)).toMatchObject([{ instance: INSTANCE, user: 'ubuntu' }]);
    expect(eice.tunnels().at(-1)).toMatchObject({
      endpoint: 'eice-0fake',
      ip: IP,
      port: 22,
      max: null,
    });
  });

  test("only your own box by its name: a teammate's box of the same name is not yours", async () => {
    aws.answer(AWS('running', [instance('running', 'teammate', 'i-0fa4e00000000beef')]));
    const out = await abe.run('box', 'attach', 'demo-shop-7', '--', 'true');

    expect(out.stderr).toBe('');
    expect(out.exit).toBe(0);
    expect(ssh.calls().at(-1)).toContain(`ubuntu@${INSTANCE}`);
    const listed = aws
      .calls()
      .filter((c) => c.argv.includes('describe-instances'))
      .at(-1);

    expect(listed?.argv).toContain('Name=tag:abe:owner,Values=octocat');
  });

  test('a word with spaces or quotes reaches the box as one word', async () => {
    const out = await abe.run(
      'box',
      'attach',
      'demo-shop-7',
      '--',
      'printf',
      '%s|',
      'a b',
      "it's",
      '$HOME',
    );

    expect(out.stdout).toBe("a b|it's|$HOME|");
  });

  test('an empty word reaches the box as an empty word (#189: a move without a transcript)', async () => {
    const out = await abe.run('box', 'attach', 'demo-shop-7', '--', 'printf', '%s|', 'a', '', 'b');

    expect(out.stderr).toBe('');
    expect(out.stdout).toBe('a||b|');
  });

  test('stdin goes through and the command sees its end', async () => {
    const out = await abe.runWith(
      { stdin: 'one\ntwo\n' },
      'box',
      'attach',
      INSTANCE,
      '--',
      'wc',
      '-l',
    );

    expect(out.stdout.trim()).toBe('2');
  });

  test('a command killed on the box (ssh says 255) is not run again', async () => {
    const runs = eice.ran().length;
    const out = await abe.run('box', 'attach', 'demo-shop-7', '--', 'sh', '-c', 'kill -9 $PPID');

    expect(out.exit).toBe(255);
    expect(eice.ran().length).toBe(runs + 1);
    expect(out.stderr).not.toContain('abe-box-attach:began');
  });

  test('takes the terminal: no --json', async () => {
    const out = await abe.run('box', 'attach', 'demo-shop-7', '--json', '--', 'true');

    expect(out.exit).toBe(2);
    expect(out.stderr + out.stdout).toContain('no --json');
  });

  test('the command only after --', async () => {
    const out = await abe.run('box', 'attach', 'demo-shop-7', 'ls');

    expect(out.exit).toBe(2);
    expect(out.stderr).toContain('after --');
  });
});

describe('abe box attach <box> --shared -- <argv>: one SSH connection for many calls (#93)', () => {
  /** Its own state: the control sockets live there. */
  let mac: Cli;
  const sockets = () => {
    const dir = join(mac.state.dir, 'mux');

    return existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => /^[0-9a-f]{8}\.[0-9a-z]+$/.test(f))
          .map((f) => join(dir, f))
      : [];
  };
  /** The live master's pid, as `ssh -O check` says it. */
  const masterPid = (socket: string) => {
    const said = Bun.spawnSync([ssh.bin, '-S', socket, '-O', 'check', 'x']).stderr.toString();

    return Number(/pid=(\d+)/.exec(said)?.[1] ?? Number.NaN);
  };
  const call = (...argv: string[]) =>
    mac.run('box', 'attach', 'demo-shop-7', '--shared', '--', ...argv);

  beforeAll(() => {
    mac = cli({ env: env() });
  });

  afterAll(async () => {
    for (const s of sockets()) Bun.spawnSync([ssh.bin, '-S', s, '-O', 'exit', 'x']);
    await mac.close();
  });

  test('five calls: one tunnel, one key pushed, AWS asked only by the first; each its own output and exit', async () => {
    const before = {
      tunnels: eice.tunnels().length,
      pushes: eice.pushes().length,
      ran: eice.ran().length,
    };
    const aws0 = aws.calls().length;
    const first = await call('sh', '-c', 'echo one; exit 3');

    expect(first).toMatchObject({ exit: 3, stdout: 'one\n', stderr: '' });
    const awsAfterFirst = aws.calls().length;

    expect(awsAfterFirst).toBeGreaterThan(aws0);
    for (const n of [2, 3, 4, 5]) {
      const out = await call('printf', '%s|', `call ${n}`, "it's");

      expect(out).toMatchObject({ exit: 0, stdout: `call ${n}|it's|`, stderr: '' });
    }
    expect(eice.tunnels().length).toBe(before.tunnels + 1);
    expect(eice.pushes().length).toBe(before.pushes + 1);
    // No address, endpoint or credentials read again: only the box's socket
    expect(aws.calls().length).toBe(awsAfterFirst);
    // The box ran the master's connection once and each call as a channel on it
    const ran = eice.ran().slice(before.ran);

    expect(ran.filter((r) => r.channel)).toHaveLength(5);
    expect(ran.filter((r) => !r.channel)).toHaveLength(1);
  });

  test("the master: a socket in the person's state (0700), ControlPersist, opened through the endpoint with a fresh key that is not kept", async () => {
    await call('true');
    const master = ssh.calls().find((a) => a.includes('-M')) ?? [];

    expect(master).toContain('-N');
    expect(master).toContain('-f');
    expect(master).toContain('ControlPersist=600');
    expect(master.find((a) => a.startsWith('ProxyCommand='))).toContain("'box' 'tunnel'");
    const socket = master[master.indexOf('-S') + 1] ?? '';

    expect(socket.startsWith(join(mac.state.dir, 'mux'))).toBe(true);
    expect(statSync(join(mac.state.dir, 'mux')).mode & 0o777).toBe(0o700);
    // The key was checked once, at the master's login; its file went with the call that made it
    const key = master[master.indexOf('-i') + 1] ?? '';

    expect(key).not.toBe('');
    expect(existsSync(key)).toBe(false);
    // A call on it: the socket, no key, no tunnel of its own
    const onIt = ssh.calls().at(-1) ?? [];

    expect(onIt).toContain(socket);
    expect(onIt).not.toContain('-i');
    expect(onIt.some((a) => a.includes("'box' 'tunnel'"))).toBe(false);
  });

  test('stdin goes through the shared connection and the command sees its end', async () => {
    const out = await mac.runWith(
      { stdin: 'one\ntwo\n' },
      'box',
      'attach',
      'demo-shop-7',
      '--shared',
      '--',
      'wc',
      '-l',
    );

    expect(out.stdout.trim()).toBe('2');
  });

  test('a master that died (its socket left behind): the next call opens a new one', async () => {
    await call('true');
    const [socket] = sockets();
    const pid = masterPid(socket ?? '');

    expect(Number.isInteger(pid)).toBe(true);
    process.kill(pid, 'SIGKILL');
    const tunnels = eice.tunnels().length;
    const out = await call('echo', 'again');

    expect(out).toMatchObject({ exit: 0, stdout: 'again\n', stderr: '' });
    expect(eice.tunnels().length).toBe(tunnels + 1);
    // and it is the one used from now on
    await call('true');
    expect(eice.tunnels().length).toBe(tunnels + 1);
  });

  test('a dropped network takes the master with it: the next call is back on a new one', async () => {
    await call('true');
    eice.outage(300);
    await until('the network back', () => (eice.isDown() ? undefined : true));
    const out = await call('echo', 'back');

    expect(out).toMatchObject({ exit: 0, stdout: 'back\n' });
  }, 20_000);

  test('calls at once with no master yet: one master made, the others wait for it', async () => {
    for (const s of sockets()) Bun.spawnSync([ssh.bin, '-S', s, '-O', 'exit', 'x']);
    await until('the masters gone', () => (sockets().length === 0 ? true : undefined));
    const tunnels = eice.tunnels().length;
    const outs = await Promise.all([1, 2, 3, 4].map((n) => call('echo', `at once ${n}`)));

    expect(outs.map((o) => o.stdout)).toEqual([1, 2, 3, 4].map((n) => `at once ${n}\n`));
    expect(eice.tunnels().length).toBe(tunnels + 1);
  }, 30_000);

  test('a lock left by a call that died while it made the master is taken over', async () => {
    for (const s of sockets()) Bun.spawnSync([ssh.bin, '-S', s, '-O', 'exit', 'x']);
    await until('the masters gone', () => (sockets().length === 0 ? true : undefined));
    const tag = createHash('sha256').update('demo-shop-7').digest('hex').slice(0, 8);
    const lock = join(mac.state.dir, 'mux', `${tag}-starting`);
    // a pid no process has
    const gone = Bun.spawn(['true']);

    await gone.exited;
    writeFileSync(lock, String(gone.pid));
    const tunnels = eice.tunnels().length;
    const out = await call('echo', 'not stuck');

    expect(out).toMatchObject({ exit: 0, stdout: 'not stuck\n' });
    expect(eice.tunnels().length).toBe(tunnels + 1);
    expect(existsSync(lock)).toBe(false);
  }, 30_000);

  test('a control socket path too long: said once on stderr, the calls go on their own connections', async () => {
    const deep = join(
      mkdtempSync(join(tmpdir(), 'abe-mux-')),
      'a-state-folder-deep-enough'.repeat(3),
    );
    const far = cli({ env: env({ ABE_STATE_DIR: deep }) });

    try {
      const first = await far.run('box', 'attach', 'demo-shop-7', '--shared', '--', 'echo', 'one');

      expect(first).toMatchObject({ exit: 0, stdout: 'one\n' });
      expect(first.stderr).toContain(
        "no shared connection to demo-shop-7 (the control socket's path is too long",
      );
      const next = await far.run('box', 'attach', 'demo-shop-7', '--shared', '--', 'echo', 'two');

      expect(next).toMatchObject({ exit: 0, stdout: 'two\n', stderr: '' });
    } finally {
      await far.close();
    }
  }, 30_000);

  test("--card only for a login shell, and only a card's id", async () => {
    const with_ = await mac.run('box', 'attach', 'demo-shop-7', '--card', '4', '--session', 'S1');
    const bad = await mac.run('box', 'attach', 'demo-shop-7', '--card', '1;rm');

    expect([with_.exit, bad.exit]).toEqual([2, 2]);
    expect(bad.stderr).toContain('--card 1;rm is not a card id');
  });

  test('only for a command: --shared with --session or a login shell is a usage error', async () => {
    const out = await mac.run('box', 'attach', 'demo-shop-7', '--shared', '--session', 'S1');

    expect(out.exit).toBe(2);
    expect(out.stderr).toContain('--shared');
  });
});

describe('abe box attach: a terminal in a reconnect loop', () => {
  test("--session: the session's terminal on the box, through its own abe", async () => {
    const attach = abe.spawn('box', 'attach', 'demo-shop-7', '--session', 'S1');

    expect(await attach.next(10_000)).toBe('attached S1 (session attach S1 --no-start)');
    expect(ssh.calls().at(-1)).toContain('-tt');
    attach.signal('SIGTERM');
    expect((await attach.exited).exit).not.toBe(0);
  });

  test("without --session: a login shell in a workspace container, --card's (#104 Behaviour 5, #244, ADR 0022)", async () => {
    // The box's Docker: two workspaces run (`ps` lists those its card filter lets through);
    // `exec` says where it went, then is that shell.
    writeFileSync(
      join(box, 'docker'),
      [
        '#!/bin/bash',
        'case "$1" in',
        '  ps) for a in "$@"; do case "$a" in label=abe.card=*) want=${a#label=abe.card=};; esac; done',
        '      for n in abe-ws-101 abe-ws-102; do [ -z "$want" ] || [ "$n" = "abe-ws-$want" ] && echo "$n"; done;;',
        '  exec) echo "in the workspace: $*"; exec /bin/bash;;',
        '  *) exit 1;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    try {
      const out = await abe.runWith(
        { stdin: 'echo $((6 * 7))\nexit 3\n' },
        'box',
        'attach',
        'demo-shop-7',
        '--card',
        '102',
      );

      expect(out.stdout).toContain(
        'in the workspace: exec -it -u abe -w /workspace/repo abe-ws-102 bash -l',
      );
      expect(out.stdout).toContain('42');
      expect(out.exit).toBe(3);
      expect(eice.ran().at(-1)).toMatchObject({ tty: true });
    } finally {
      rmSync(join(box, 'docker'));
    }
  });

  test("no workspace running: the box's own login shell, said so", async () => {
    const out = await abe.runWith(
      { stdin: 'echo $((6 * 7))\nexit 3\n' },
      'box',
      'attach',
      'demo-shop-7',
    );

    expect(out.stdout).toContain('42');
    expect(`${out.stdout}${out.stderr}`).toContain(
      'abe: no workspace container answers on this box: its own shell',
    );
    expect(out.exit).toBe(3);
  });

  test('a dropped network: back within 5 s of its return, with the same key (pushed < 60 s ago)', async () => {
    const attach = abe.spawn('box', 'attach', 'demo-shop-7', '--session', 'S2');

    expect(await attach.next(10_000)).toStartWith('attached S2');
    const pushes = eice.pushes().length;
    const runs = eice.ran().length;

    eice.outage(1500);
    const back = Date.now() + 1500;

    expect(await attach.next(15_000)).toStartWith('attached S2');
    expect(Date.now() - back).toBeLessThan(5_000);
    expect(eice.ran().length).toBe(runs + 1);
    expect(eice.pushes().length).toBe(pushes);
    attach.signal('SIGTERM');
    await attach.exited;
  }, 30_000);

  test("the tunnel's time cap is only a short pause", async () => {
    const capped = cli({ env: env({ ABE_BOX_TUNNEL_MAX_SECONDS: '2' }) });
    const attach = capped.spawn('box', 'attach', 'demo-shop-7', '--session', 'S3');

    expect(await attach.next(10_000)).toStartWith('attached S3');
    const first = Date.now();

    expect(await attach.next(10_000)).toStartWith('attached S3');
    // Cut at 2 s, back at once.
    expect(Date.now() - first).toBeLessThan(2_000 + 3_000);
    expect(eice.tunnels().at(-1)).toMatchObject({ max: 2 });
    attach.signal('SIGTERM');
    await attach.exited;
    await capped.close();
  }, 30_000);

  test('a refusal that trying again cannot mend ends it at once', async () => {
    const lonely = fakeEice({
      instance: INSTANCE,
      ip: IP,
      env: { PATH: '/usr/bin:/bin' },
      cwd: box,
    });
    const denied = cli({ env: env({ ABE_EICE_URL: lonely.url }) });

    lonely.deny(INSTANCE);
    const before = ssh.calls().length;
    const out = await denied.run('box', 'attach', 'demo-shop-7', '--session', 'S4');

    expect(out.exit).toBe(1);
    expect(out.stderr).toContain(`not authorized for ${INSTANCE}`);
    expect(ssh.calls().length).toBe(before + 1);
    lonely.stop();
    await denied.close();
  });

  test('a refused handshake says only its status, never the signed URL', async () => {
    eice.refuseTunnels(401);
    const out = await abe.run('box', 'attach', 'demo-shop-7', '--session', 'S6');

    eice.refuseTunnels(null);
    expect(out.exit).toBe(1);
    expect(out.stderr).toContain('open-tunnel: handshake refused (HTTP 401)');
    expect(out.stderr).not.toContain(FAKE_KEYS.sessionToken);
    expect(out.stderr).not.toContain('X-Amz');
  });

  test('a key whose push failed is never offered again: the next connection pushes a new one', async () => {
    const before = eice.pushes().length;

    eice.failPushes(1);
    const started = Date.now();
    const attach = abe.spawn('box', 'attach', 'demo-shop-7', '--session', 'S7');

    expect(await attach.next(10_000)).toStartWith('attached S7');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(eice.pushes().length).toBe(before + 1);
    attach.signal('SIGTERM');
    await attach.exited;
  }, 20_000);

  test('a stopped box is woken first; a box it may not wake says so', async () => {
    aws.answer(AWS('stopped'));
    const out = await abe.run('box', 'attach', 'demo-shop-7', '--session', 'S5');

    expect(out.exit).toBe(1);
    expect(out.stderr).toContain('Waking demo-shop-7…');
    expect(aws.calls().some((c) => c.argv.includes('start-instances'))).toBe(true);
  });

  test('a command that had started is not run again after a drop', async () => {
    const run = abe.spawn(
      'box',
      'attach',
      'demo-shop-7',
      '--',
      'sh',
      '-c',
      'echo started; exec sleep 60',
    );

    expect(await run.next(10_000)).toBe('started');
    const runs = eice.ran().length;

    eice.outage(500);
    expect((await run.exited).exit).toBe(255);
    expect(eice.ran().length).toBe(runs);
    // The network back before the next test.
    await until('the network back', () => (eice.isDown() ? undefined : true));
  }, 20_000);
});

describe('abe box forward', () => {
  test("a local port reaches the box's dev server, and again after a drop", async () => {
    const dev = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('dev server on the box'),
    });
    const fwd = abe.spawn('box', 'forward', 'demo-shop-7', String(dev.port), '--json');
    const doc = readEnvelope(BoxForwardData, JSON.parse(await fwd.next(15_000)));

    if (!doc.ok) throw new Error(doc.error.message);
    const local = `http://127.0.0.1:${doc.data.local}/`;

    expect(await (await fetch(local)).text()).toBe('dev server on the box');
    eice.outage(1000);
    const again = await until(
      'the forward back',
      async () => {
        try {
          return await (await fetch(local)).text();
        } catch {
          return undefined;
        }
      },
      { ms: 10_000, every: 200 },
    );

    expect(again).toBe('dev server on the box');
    fwd.signal('SIGINT');
    const ended = await fwd.exited;

    expect(ended.exit).toBe(0);
    // --json: stderr says nothing, stdout is the one document.
    expect(ended.stderr).toBe('');
    void dev.stop(true);
  }, 30_000);

  test('in text mode it says at once what it opens (#193)', async () => {
    const fwd = abe.spawn('box', 'forward', 'demo-shop-7', '22');

    expect(await fwd.next(15_000)).toContain('demo-shop-7');
    fwd.signal('SIGINT');
    const ended = await fwd.exited;

    expect(ended.stderr).toStartWith(
      'demo-shop-7: opening a tunnel to its port 22 (EC2 Instance Connect)…\n',
    );
  }, 30_000);
});

/** The Mac's serve's link, in this process: the real tunnel run as `abe box tunnel` by the fake ssh. */
const macLink = () =>
  eiceLinkFrom({ ...env(), HOME: abe.state.dir, ABE_STATE_DIR: abe.state.dir }, [
    process.execPath,
    join(import.meta.dir, '..', 'main.ts'),
  ]);

const event = (seq: number) => {
  appendFileSync(
    join(box, 'events.jsonl'),
    `${JSON.stringify({ seq, at: '2026-10-23T11:00:00.000Z', type: 'session.state', data: {} })}\n`,
  );
};

describe('the link serve reaches a box by (BoxLink over EICE)', () => {
  test('run: abe <argv> on the box, each word quoted, never starting a serve there', async () => {
    const link = macLink();
    const ran = await link.run('demo-shop-7', ['status', '--json']);

    expect(ran).toMatchObject({ exit: 0, stdout: '{"ok":true,"data":{"on":"box"}}\n' });
    expect(eice.ran().at(-1)?.command).toBe("'abe' 'status' '--json' '--no-start'");
    expect(link.attach('demo-shop-7', ['session', 'attach', 'S1'])).toEqual([
      process.execPath,
      join(import.meta.dir, '..', 'main.ts'),
      'box',
      'attach',
      'demo-shop-7',
      '--',
      'abe',
      'session',
      'attach',
      'S1',
      '--no-start',
    ]);
    link.close();
  });

  test('a box read asleep, then woken: read again, never said stopped while it runs (#143)', async () => {
    aws.answer(AWS('stopped'));
    const link = macLink();
    const asleep = await link.run('demo-shop-7', ['status', '--json']);

    expect(asleep).toEqual({
      exit: 255,
      stdout: '',
      stderr: 'box demo-shop-7 is stopped · abe box start demo-shop-7 wakes it\n',
    });
    // Woken meanwhile (by the person, or this serve's wake): EC2 asked again, the box reached.
    aws.answer(AWS('running'));
    expect(await link.run('demo-shop-7', ['status', '--json'])).toMatchObject({
      exit: 0,
      stdout: '{"ok":true,"data":{"on":"box"}}\n',
    });
    link.close();
  }, 30_000);

  test('a key pushed to one box is never offered to another: each box gets its own push', async () => {
    const other = {
      ...instance('running', 'octocat', OTHER.instance),
      PrivateIpAddress: OTHER.ip,
      Tags: [
        { Key: 'abe:box', Value: OTHER.name },
        { Key: 'abe:owner', Value: 'octocat' },
      ],
    };

    aws.answer(AWS('running', [other]));
    const link = macLink();
    const before = eice.pushes().length;

    expect(await link.run('demo-shop-7', ['status', '--json'])).toMatchObject({ exit: 0 });
    // Right after (well inside the key's reuse time), the other box.
    expect(await link.run(OTHER.name, ['status', '--json'])).toMatchObject({
      exit: 0,
      stdout: '{"ok":true,"data":{"on":"box"}}\n',
    });
    expect(
      eice
        .pushes()
        .slice(before)
        .map((p) => p.instance),
    ).toEqual([INSTANCE, OTHER.instance]);
    // The first box again: its own key, still within its reuse time, not pushed again.
    expect(await link.run('demo-shop-7', ['status', '--json'])).toMatchObject({ exit: 0 });
    expect(eice.pushes().length).toBe(before + 2);
    link.close();
  }, 30_000);

  test('abe --on <box> watch: a dropped network is followed again with --since, no event lost or twice', async () => {
    const link = macLink();
    const boxes: BoxFront = {
      off: () => false,
      busy: () => 0,
      list: () => Promise.reject(new Error('unused')),
      status: () => Promise.reject(new Error('unused')),
      up: () => Promise.reject(new Error('unused')),
      start: () => Promise.reject(new Error('unused')),
      stop: () => Promise.reject(new Error('unused')),
      keepAwake: () => Promise.reject(new Error('unused')),
      terminate: () => Promise.reject(new Error('unused')),
      wake: (name) =>
        Promise.resolve({
          ok: true,
          data: {
            id: INSTANCE,
            name,
            owner: 'octocat',
            state: 'running',
            size: 'm8g.large',
            zone: 'eu-west-1a',
            privateIp: IP,
            vpc: null,
            subnet: null,
            repo: null,
            card: null,
          },
        }),
      made: () => Promise.reject(new Error('unused')),
      said: () => undefined,
      booting: (_, wait) => wait(),
      runs: () => Promise.resolve(true),
      forward: () => Promise.reject(new Error('unused')),
      sessions: () => Promise.resolve({ sessions: [], unread: null, notes: [] }),
      discover: () => Promise.resolve(),
      keep: () => undefined,
      release: () => undefined,
      stoppedHere: () => false,
      onEvent: () => undefined,
      close: () => undefined,
    };
    const seen: number[] = [];
    let closed: () => void = () => undefined;
    const answer = await onBoxAnswer(boxes, link, [], 'demo-shop-7', ['watch', '--json'], {
      retryMs: 50,
      sleep: (ms) => Bun.sleep(ms),
    });

    if (!('stream' in answer)) throw new Error('watch is a stream');
    answer.stream({
      send: (line) => {
        const f = WatchFrame.parse(JSON.parse(line));

        if ('event' in f) seen.push(f.event.seq);

        return true;
      },
      end: () => undefined,
      cut: () => false,
      onClose: (fn) => {
        closed = fn;
      },
    });
    event(1);
    event(2);
    await until('two events', () => (seen.length >= 2 ? true : undefined), { ms: 15_000 });
    eice.outage(800);
    event(3);
    event(4);
    await until('all four', () => (seen.length >= 4 ? true : undefined), { ms: 20_000 });
    event(5);
    await until('the fifth', () => (seen.length >= 5 ? true : undefined), { ms: 10_000 });
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(
      eice.ran().some((r) => r.command === "'abe' 'watch' '--since' '2' '--json' '--no-start'"),
    ).toBe(true);
    closed();
    link.close();
  }, 40_000);
});

describe('#338: the app runs abe box attach without AWS in its environment', () => {
  /** The Mac's serve, started as the try-out starts it: its box profile and region set. */
  let served: Cli;
  /** VimStorm opened from the Dock: no AWS_PROFILE, no AWS_REGION; the same serve's socket. */
  let app: Cli;

  beforeAll(async () => {
    served = cli({
      env: env({ AWS_PROFILE: '', ABE_BOX_PROFILE: 'abe-play', AWS_REGION: 'eu-north-1' }),
    });
    expect((await served.run('status')).exit).toBe(0);
    app = cli({
      env: {
        PATH: `${gh.dir}:${aws.path}`,
        ABE_SSH: ssh.bin,
        ABE_EICE_URL: eice.url,
        ABE_STATE_DIR: served.state.dir,
        ABE_SOCKET: served.state.socket,
        HOME: served.state.dir,
      },
    });
  });

  afterAll(async () => {
    await served.close();
  });

  /** The attach's own credentials read (serve reads EC2 too, never its keys). */
  const exportsSince = (n: number) =>
    aws
      .calls()
      .slice(n)
      .filter((c) => c.argv.includes('export-credentials'));

  test("a command reaches EC2 on serve's box profile and region, not the app's empty env", async () => {
    const before = aws.calls().length;
    const out = await app.run('box', 'attach', 'demo-shop-7', '--', 'echo', 'hi');

    expect(out).toMatchObject({ exit: 0, stdout: 'hi\n', stderr: '' });
    const found = aws
      .calls()
      .slice(before)
      .filter(
        (c) => c.argv.includes('describe-instances') || c.argv.includes('export-credentials'),
      );

    expect(found.map((c) => c.argv.includes('export-credentials'))).toContain(true);
    for (const c of found) {
      expect(c.env.AWS_PROFILE).toBe('abe-play');
      expect(c.env.AWS_REGION).toBe('eu-north-1');
    }
  });

  test('a forward too', async () => {
    const before = aws.calls().length;
    const fwd = app.spawn('box', 'forward', 'demo-shop-7', '22');

    expect(await fwd.next(15_000)).toContain('demo-shop-7');
    fwd.signal('SIGINT');
    await fwd.exited;
    const calls = exportsSince(before);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.env).toMatchObject({ AWS_PROFILE: 'abe-play', AWS_REGION: 'eu-north-1' });
  }, 30_000);

  test('a serve that does not say (an older one): the attach goes on its own environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abe-old-'));
    const socket = join(dir, 's.sock');
    const status = {
      version: '2.1.0',
      pid: 1,
      startedAt: '2026-10-25T10:00:00.000Z',
      socket,
      sessions: 0,
      workspaces: 0,
    };
    const old = Bun.listen({
      unix: socket,
      socket: {
        data: (s) => {
          s.write(
            `${JSON.stringify({ v: 1, exit: 0, stdout: `${JSON.stringify({ ok: true, data: status })}\n`, stderr: '' })}\n`,
          );
          s.end();
        },
      },
    });
    const own = cli({
      env: env({ AWS_PROFILE: 'mine', AWS_REGION: 'eu-west-1', ABE_SOCKET: socket }),
    });
    const before = aws.calls().length;

    try {
      const out = await own.run('box', 'attach', 'demo-shop-7', '--', 'true');

      expect(out).toMatchObject({ exit: 0, stderr: '' });
      expect(exportsSince(before)[0]?.env).toMatchObject({
        AWS_PROFILE: 'mine',
        AWS_REGION: 'eu-west-1',
      });
    } finally {
      old.stop(true);
      await own.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
