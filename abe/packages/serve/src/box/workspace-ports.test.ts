/**
 * A box's side of a dev server forwarded to the Mac (#16), through the socket protocol with a fake
 * Docker: `abe workspace ports` looks in each running workspace, `abe workspace relay` reaches a
 * port in one from the box's own loopback (a real listener, `cat` for `abe port pipe`), and the
 * watcher says `workspace.ports` when what listens changes.
 */
import { describe, expect, test } from 'bun:test';
import {
  type EventLine,
  PORTS_PROBE_MARK,
  readEnvelope,
  type Reply,
  WorkspaceData,
  WorkspacePortsList,
  WorkspaceRelay,
} from '@abe/core';
import { heldEvents, scenario, type ServeScenario, until } from '@abe/testing';
import { type z } from 'zod';

const REPO = 'mkdir-swe/demo-shop';

const data = <T extends z.ZodType>(schema: T, reply: Reply): z.output<T> => {
  const doc = readEnvelope(schema, JSON.parse(reply.stdout));

  if (!doc.ok) throw new Error(`${doc.error.code}: ${doc.error.message}`);

  return doc.data;
};

const errorOf = (reply: Reply) => {
  const doc = readEnvelope(WorkspaceData, JSON.parse(reply.stdout));

  if (doc.ok) throw new Error(`expected a refusal, got ${reply.stdout}`);

  return doc.error.code;
};

/** `/proc/net/tcp` with these ports listening on 127.0.0.1. */
const listening = (...ports: number[]) =>
  [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    ...ports.map(
      (p) =>
        `   0: 0100007F:${p.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1`,
    ),
  ].join('\n');

/**
 * A box with these cards' workspaces up; what the probe prints in each container comes from
 * `inside` (a container not there answers nothing listening; `fail`: its exec fails).
 */
const onBox = async (cards: string[], o: { portsEveryMs?: number } = {}) => {
  const s = await scenario({ box: true, ...o });

  s.box.mirrors.trees.set(REPO, 'tree1');
  for (const card of cards)
    expect(
      (await s.request('workspace', 'up', '--repo', REPO, '--card', card, '--json')).exit,
    ).toBe(0);

  return s;
};

/** What each workspace prints for the probe, by container; `null`: its exec fails. */
const probes = (s: ServeScenario, by: Record<string, string | null>) => {
  s.box.docker.onExec = (name, argv) => {
    if (argv[0] !== 'sh' || argv[2]?.includes(PORTS_PROBE_MARK) !== true)
      return { exit: 0, stdout: '', stderr: '' };
    const out = by[name];

    if (out === null) return { exit: 1, stdout: '', stderr: 'OCI runtime exec failed' };

    return { exit: 0, stdout: `${out ?? listening()}\n${PORTS_PROBE_MARK}\n`, stderr: '' };
  };
};

const ports = (s: ServeScenario, ...argv: string[]) =>
  s.request('workspace', 'ports', ...argv, '--json');

describe('abe workspace ports', () => {
  test.each<[string, Record<string, string | null>, string[], WorkspacePortsList['workspaces']]>([
    [
      'two workspaces on one box both on 3000: each listed by its card',
      { 'abe-ws-101': listening(3000), 'abe-ws-102': listening(3000, 5173) },
      [],
      [
        { card: '101', ports: [3000], fixed: [] },
        { card: '102', ports: [3000, 5173], fixed: [] },
      ],
    ],
    [
      '--card: that workspace only',
      { 'abe-ws-101': listening(3000), 'abe-ws-102': listening(4000) },
      ['--card', '102'],
      [{ card: '102', ports: [4000], fixed: [] }],
    ],
    [
      'one whose exec fails is left out, the rest answered',
      { 'abe-ws-101': null, 'abe-ws-102': listening(4000) },
      [],
      [{ card: '102', ports: [4000], fixed: [] }],
    ],
  ])('%s', async (_, by, argv, want) => {
    await using s = await onBox(['101', '102']);

    probes(s, by);
    expect(data(WorkspacePortsList, await ports(s, ...argv)).workspaces).toEqual(want);
  });

  test('a stopped workspace is left out', async () => {
    await using s = await onBox(['101', '102']);
    const stopped = s.box.docker.containersByName.get('abe-ws-102');

    probes(s, { 'abe-ws-101': listening(3000), 'abe-ws-102': listening(3000) });
    if (stopped !== undefined) stopped.state = 'exited';
    expect(data(WorkspacePortsList, await ports(s)).workspaces).toEqual([
      { card: '101', ports: [3000], fixed: [] },
    ]);
  });

  test('the probe looks in the clone as the container runs it', async () => {
    await using s = await onBox(['101']);

    await ports(s);
    const probe = s.box.docker.execs.find((e) => e.argv[2]?.includes(PORTS_PROBE_MARK) === true);

    expect(probe?.name).toBe('abe-ws-101');
    expect(probe?.argv.slice(0, 2)).toEqual(['sh', '-c']);
    expect(probe?.argv[2]).toContain('\'/workspace/repo\'/"$f"');
  });
});

describe('workspace ports and relay are a box serve’s', () => {
  test.each([
    [['workspace', 'ports', '--json']],
    [['workspace', 'relay', '101', '3000', '--json']],
  ])('%j locally: not a box', async (argv) => {
    await using s = await scenario();

    expect(errorOf(await s.request(...argv))).toBe('not-a-box');
  });
});

const relay = (s: ServeScenario, card: string, port: number) =>
  s.request('workspace', 'relay', card, String(port), '--json');

/** Bytes through the relay at `port`: what came back. */
const through = async (port: number, text: string) => {
  const { promise, resolve } = Promise.withResolvers<string>();
  let got = '';
  const sock = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data: (sk, d) => {
        got += d.toString();
        if (got.length >= text.length) {
          sk.end();
          resolve(got);
        }
      },
    },
  });

  sock.write(text);

  return promise;
};

const refusedAt = async (port: number) => {
  try {
    (await Bun.connect({ hostname: '127.0.0.1', port, socket: { data: () => undefined } })).end();

    return false;
  } catch {
    return true;
  }
};

describe('abe workspace relay', () => {
  test("the box's 127.0.0.1 port reaches the workspace's, through the pipe run in its container", async () => {
    await using s = await onBox(['101', '102']);
    const r = data(WorkspaceRelay, await relay(s, '101', 3000));

    expect(r).toMatchObject({ card: '101', port: 3000 });
    expect(await through(r.relay, 'GET / HTTP/1.1\r\n\r\n')).toBe('GET / HTTP/1.1\r\n\r\n');
    // Asked again: the same relay; another card's 3000 its own.
    expect(data(WorkspaceRelay, await relay(s, '101', 3000)).relay).toBe(r.relay);
    expect(data(WorkspaceRelay, await relay(s, '102', 3000)).relay).not.toBe(r.relay);
    expect(s.box.relays.opened).toEqual([
      { container: 'abe-ws-101', port: 3000 },
      { container: 'abe-ws-102', port: 3000 },
    ]);
  });

  test.each<[string, string, (s: ServeScenario) => void]>([
    ['no workspace for the card', '103', () => undefined],
    [
      'its workspace stopped',
      '102',
      (s) => {
        const c = s.box.docker.containersByName.get('abe-ws-102');

        if (c !== undefined) c.state = 'exited';
      },
    ],
  ])('refused: %s', async (_, card, arrange) => {
    await using s = await onBox(['102']);

    arrange(s);
    expect(errorOf(await relay(s, card, 3000))).toBe('no-workspace');
  });

  test.each<[string, (s: ServeScenario) => Promise<unknown>]>([
    ['its workspace removed', (s) => s.request('workspace', 'rm', '101', '--json')],
    [
      'its workspace stopped (the watcher sees it gone)',
      (s) => {
        const c = s.box.docker.containersByName.get('abe-ws-101');

        if (c !== undefined) c.state = 'exited';

        return Promise.resolve();
      },
    ],
    ['serve stopped', (s) => s.serve.stop()],
  ])('dropped: %s', async (_, end) => {
    await using s = await onBox(['101'], { portsEveryMs: 30 });
    const r = data(WorkspaceRelay, await relay(s, '101', 3000));

    await end(s);
    await until('the relay closed', async () => ((await refusedAt(r.relay)) ? true : undefined));
  });
});

const portEvents = async (s: ServeScenario): Promise<EventLine[]> =>
  (await heldEvents(s.state.socket, 100)).filter((e) => e.type === 'workspace.ports');

describe('workspace.ports: said when what listens in a workspace changes', () => {
  test('first look said only when something listens; a change said once; gone said empty once', async () => {
    await using s = await onBox(['101', '102'], { portsEveryMs: 30 });
    const by: Record<string, string> = { 'abe-ws-101': listening(3000), 'abe-ws-102': listening() };

    probes(s, by);
    const datas = async () => (await portEvents(s)).map((e) => e.data);

    await until('101 said', async () => ((await datas()).length >= 1 ? true : undefined));
    by['abe-ws-102'] = listening(5173);
    await until('102 said', async () => ((await datas()).length >= 2 ? true : undefined));
    const stopped = s.box.docker.containersByName.get('abe-ws-101');

    if (stopped !== undefined) stopped.state = 'exited';
    await until('101 gone', async () => ((await datas()).length >= 3 ? true : undefined));
    // Some more looks: nothing new.
    await Bun.sleep(150);
    expect(await datas()).toEqual([
      { card: '101', ports: [3000], fixed: [] },
      { card: '102', ports: [5173], fixed: [] },
      { card: '101', ports: [], fixed: [] },
    ]);
  });
});
