/**
 * A dev server on a box, forwarded to this Mac (#16): `abe port list|open|close` through a real
 * `serve` in this process with a fake `Boxes` and a fake `BoxLink`, whose boxes answer
 * `workspace ports` and `workspace relay` per workspace (card), whose `forward` takes the first
 * wanted local port not taken here, and whose `watch` stream a test writes `box.state` lines into.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  type Box,
  type Boxes,
  type BoxLink,
  type Forwarded,
  PortForward,
  PortListData,
  PrototypeListData,
  PrototypeMeta,
  type Ran,
  type WorkspacePorts,
} from '@abe/core';
import {
  localPrototypeApps,
  localPrototypeProxy,
  localPrototypes,
  protoWorktrees,
} from '@abe/ports';
import { scenario, type ServeScenario, until } from '@abe/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const BOX = 'demo-shop-1';

const boxOf = (name: string, state: Box['state']): Box => ({
  id: `i-${name}`,
  name,
  owner: 'octocat',
  state,
  size: 'm8g.large',
  zone: 'eu-west-1a',
  privateIp: '10.0.0.1',
  vpc: null,
  subnet: null,
  repo: 'mkdir-swe/demo-shop',
  card: 1,
});

const nothing = () => Promise.reject(new Error('not in this test'));
const ran = (data: unknown): Ran => ({
  exit: 0,
  stdout: `${JSON.stringify({ ok: true, data })}\n`,
  stderr: '',
});

type World = {
  w: ServeScenario;
  /** Local ports something else holds on this Mac. */
  taken: Set<number>;
  /** The relays asked for, `<card>:<port>`. */
  relays: string[];
  /** The forwards open now, by local port. */
  open: Map<number, number>;
  /** A `box.state` line on the box's followed stream. */
  say: (state: 'stopping' | 'running') => void;
  down: (asleep: boolean) => void;
};

const worlds: World[] = [];

afterEach(async () => {
  for (const { w } of worlds.splice(0)) await w.close();
});

/** A Mac's serve with box `BOX` running and its workspaces listening as given. */
const world = async (workspaces: WorkspacePorts[], prototypes?: string): Promise<World> => {
  const taken = new Set<number>();
  const relays: string[] = [];
  const open = new Map<number, number>();
  let asleep = false;
  let line: ((text: string) => void) | undefined;
  let seq = 0;
  let relayPort = 41000;
  const link: BoxLink = {
    run: (_box, argv) => {
      const [noun, verb, card, port] = argv;

      if (noun === 'workspace' && verb === 'ports') {
        const only = argv.includes('--card') ? argv[argv.indexOf('--card') + 1] : undefined;

        return Promise.resolve(
          ran({ workspaces: workspaces.filter((x) => only === undefined || x.card === only) }),
        );
      }
      if (noun === 'workspace' && verb === 'relay') {
        relays.push(`${card ?? ''}:${port ?? ''}`);
        relayPort += 1;

        return Promise.resolve(ran({ card, port: Number(port), relay: relayPort }));
      }

      return Promise.resolve({ exit: 1, stdout: '', stderr: 'unknown command' });
    },
    follow: (_box, _argv, onLine) => {
      line = onLine;

      return { stop: () => undefined, ended: new Promise<number>(() => undefined) };
    },
    attach: () => [],
    forward: (_box, remote, wanted) => {
      const local =
        wanted === undefined
          ? 50000 + open.size
          : wanted.find((p) => !taken.has(p) && !open.has(p));

      if (local === undefined)
        return Promise.resolve({
          ok: false,
          error: { code: 'port-taken', message: 'taken on this machine' },
        });
      open.set(local, remote);
      const f: Forwarded = {
        port: local,
        stop: () => {
          open.delete(local);
        },
        ended: new Promise<string>(() => undefined),
      };

      return Promise.resolve({ ok: true, data: f });
    },
  };
  const ec2: Boxes = {
    list: () => Promise.resolve({ ok: true, data: [boxOf(BOX, asleep ? 'stopped' : 'running')] }),
    status: () => Promise.resolve({ ok: true, data: boxOf(BOX, asleep ? 'stopped' : 'running') }),
    up: nothing,
    start: nothing,
    stop: nothing,
    resize: nothing,
    terminate: nothing,
  };
  const w = await scenario({
    cloud: { boxes: ec2, link, self: ['abe'], sleep: (ms) => Bun.sleep(ms) },
    ...(prototypes === undefined
      ? {}
      : {
          prototypes: {
            dir: prototypes,
            apps: localPrototypeApps({ dir: prototypes, env: process.env }),
            proxy: localPrototypeProxy(),
            worktrees: protoWorktrees({ PATH: '/usr/bin:/bin', HOME: prototypes }),
          },
        }),
  });
  const made: World = {
    w,
    taken,
    relays,
    open,
    say: (state) => {
      seq += 1;
      line?.(
        JSON.stringify({
          seq,
          at: new Date().toISOString(),
          type: 'box.state',
          data: { box: BOX, state, cause: 'idle' },
        }),
      );
    },
    down: (a) => {
      asleep = a;
    },
  };

  worlds.push(made);

  return made;
};

const json = async <T extends z.ZodType>(w: ServeScenario, schema: T, ...argv: string[]) => {
  const reply = await w.request(...argv, '--json');
  const doc = z
    .union([
      z.object({ ok: z.literal(true), data: schema }),
      z.object({
        ok: z.literal(false),
        error: z.object({ code: z.string(), message: z.string() }),
      }),
    ])
    .parse(JSON.parse(reply.stdout || reply.stderr));

  return doc;
};

const opened = async (w: ServeScenario, card: string, port: number) => {
  const doc = await json(w, PortForward, 'port', 'open', BOX, card, String(port));

  return doc.ok ? doc.data : doc.error;
};

describe('a forward: the local port', () => {
  const rows: {
    rule: string;
    fixed: number[];
    taken: number[];
    want: Record<string, unknown>;
  }[] = [
    {
      rule: "the box's own port when free",
      fixed: [],
      taken: [],
      want: { local: 3000, state: 'open', fixed: false },
    },
    {
      rule: 'the next free one when taken, said',
      fixed: [],
      taken: [3000, 3001],
      want: { local: 3002, state: 'open', note: 'localhost:3000 was taken' },
    },
    {
      rule: 'a fixed one that port only, taken: refused, one run at a time',
      fixed: [3000],
      taken: [3000],
      want: { code: 'port-taken' },
    },
    {
      rule: 'a fixed one free: that port',
      fixed: [3000],
      taken: [],
      want: { local: 3000, fixed: true },
    },
  ];

  for (const r of rows)
    test(r.rule, async () => {
      const x = await world([{ card: '101', ports: [3000], fixed: r.fixed }]);

      for (const p of r.taken) x.taken.add(p);
      expect(await opened(x.w, '101', 3000)).toMatchObject(r.want);
    });
});

describe('forwards per workspace', () => {
  test('two workspaces on one box both on :3000: two forwards, two local ports, two relays', async () => {
    const x = await world([
      { card: '101', ports: [3000], fixed: [] },
      { card: '102', ports: [3000], fixed: [] },
    ]);

    expect(await opened(x.w, '101', 3000)).toMatchObject({ card: '101', local: 3000 });
    expect(await opened(x.w, '102', 3000)).toMatchObject({
      card: '102',
      local: 3001,
      note: 'localhost:3000 was taken',
    });
    expect(x.relays).toEqual(['101:3000', '102:3000']);
  });

  test('a fixed port held by our other forward: refused naming it', async () => {
    const x = await world([
      { card: '101', ports: [3000], fixed: [3000] },
      { card: '102', ports: [3000], fixed: [3000] },
    ]);

    await opened(x.w, '101', 3000);
    const second = await opened(x.w, '102', 3000);

    expect(second).toMatchObject({ code: 'port-taken' });
    expect(JSON.stringify(second)).toContain(`abe port close ${BOX} 101 3000 frees it`);
  });

  test('list: forwarded ones held, the rest offered; close lets it go', async () => {
    const x = await world([{ card: '101', ports: [3000, 5173], fixed: [5173] }]);

    await opened(x.w, '101', 3000);
    const listed = await json(x.w, PortListData, 'port', 'list');

    expect(listed.ok && listed.data.forwards.map((f) => [f.card, f.port, f.local])).toEqual([
      ['101', 3000, 3000],
    ]);
    expect(listed.ok && listed.data.offered).toEqual([
      { box: BOX, card: '101', port: 5173, fixed: true },
    ]);
    const closed = await json(
      x.w,
      z.object({ closed: z.literal(true) }),
      'port',
      'close',
      BOX,
      '101',
      '3000',
    );

    expect(closed.ok).toBe(true);
    expect(x.open.size).toBe(0);
    expect(await json(x.w, PortListData, 'port', 'list')).toMatchObject({
      data: { forwards: [], offered: [{ port: 3000 }, { port: 5173 }] },
    });
  });

  test('no running workspace for the card: refused', async () => {
    const x = await world([{ card: '101', ports: [3000], fixed: [] }]);

    expect(await opened(x.w, '999', 3000)).toMatchObject({ code: 'no-workspace' });
  });
});

describe('the box sleeping and waking', () => {
  test('asleep with its box, open again on its wake on the same local port', async () => {
    const x = await world([{ card: '101', ports: [3000], fixed: [] }]);

    x.taken.add(3000);
    expect(await opened(x.w, '101', 3000)).toMatchObject({ local: 3001 });
    x.taken.delete(3000);
    x.down(true);
    x.say('stopping');
    await until('asleep', async () => {
      const l = await json(x.w, PortListData, 'port', 'list');

      return l.ok && l.data.forwards[0]?.state === 'asleep' ? true : undefined;
    });
    expect(x.open.size).toBe(0);
    x.down(false);
    x.say('running');
    const back = await until('open again', async () => {
      const l = await json(x.w, PortListData, 'port', 'list');
      const f = l.ok ? l.data.forwards[0] : undefined;

      return f?.state === 'open' ? f : undefined;
    });

    expect(back.local).toBe(3001);
    expect(x.relays).toEqual(['101:3000', '101:3000']);
  });

  test('a box not running: refused, never woken', async () => {
    const x = await world([{ card: '101', ports: [3000], fixed: [] }]);

    x.down(true);
    expect(await opened(x.w, '101', 3000)).toMatchObject({ code: 'box-not-running' });
  });
});

describe('a prototype on a box (serve.target cloud): its app forwarded here as its preview link', () => {
  test('prototype list opens a forward to the port its workspace listens on, and keeps it as its url, live', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abe-proto-'));
    const id = 'proto-1a2b3c';

    try {
      const { w, relays } = await world([{ card: id, ports: [5173], fixed: [] }], dir);

      await localPrototypes(dir).write(
        PrototypeMeta.parse({
          id,
          card: null,
          repo: '/r/shop',
          remote: null,
          branch: 'main',
          commit: 'a'.repeat(40),
          state: 'starting',
          since: '2026-10-28T10:00:00.000Z',
          url: null,
          app: null,
          code: {
            session: `${id}-9f2e`,
            branch: 'proto/1a2b3c-dark-header',
            worktree: '/workspace/repo',
            box: BOX,
          },
        }),
      );
      const listed = await json(w, PrototypeListData, 'prototype', 'list');

      expect(listed.ok ? listed.data.prototypes : listed).toMatchObject([
        { id, state: 'live', url: 'http://127.0.0.1:5173' },
      ]);
      expect(relays).toEqual([`${id}:5173`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
