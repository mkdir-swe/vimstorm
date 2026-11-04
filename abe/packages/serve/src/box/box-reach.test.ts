/**
 * Where a box stands when a command does not get through to its `serve` (#143), through
 * `startBoxFront` with a fake `Boxes` and a fake `BoxLink`: a box EC2 says runs whose `serve`
 * does not answer yet is said running with its serve not answering (never told to wake), one
 * the link cannot reach is said so with the link's words, and one that went to sleep meanwhile
 * asleep. The same words in `--on`, `box status` and `session list`'s note.
 */
import { describe, expect, test } from 'bun:test';
import {
  type Box,
  type Boxes,
  type BoxLink,
  boxText,
  journal,
  type Ran,
  sessionListNote,
} from '@abe/core';
import { fakeClock, T0 } from '@abe/testing';
import { z } from 'zod';
import { startBoxFront } from './boxes';

const MIN = 60_000;

const box = (state: Box['state'] = 'running'): Box => ({
  id: 'i-0123456789abcdef0',
  name: 'demo-shop-1',
  owner: 'octocat',
  state,
  size: 'm8g.large',
  zone: 'eu-west-1a',
  privateIp: '10.0.0.4',
  vpc: null,
  subnet: null,
  repo: 'mkdir-swe/demo-shop',
  card: 1,
  // Started 2 minutes before the clock's now.
  launchedAt: new Date(T0 - 2 * MIN).toISOString(),
});

/** What the box's own `abe` prints when its serve does not answer (its client, `--no-start`). */
const NO_SERVE: Ran = {
  exit: 3,
  stdout:
    '{"ok":false,"error":{"code":"serve-unreachable","message":"no abe serve answers on /run/abe/serve.sock"}}\n',
  stderr: '',
};

/** The box's `serve` with every `abe` on it answering `ran`; EC2 says each read the next state. */
const front = (ran: Ran | (() => Ran), states: Box['state'][] = ['running'], bootMs?: number) => {
  const clock = fakeClock();
  const read: Box['state'][] = [...states];
  const now = () => box(read.length > 1 ? (read.shift() ?? 'running') : (read[0] ?? 'running'));
  const boxes: Boxes = {
    list: () => Promise.resolve({ ok: true, data: [now()] }),
    status: () => Promise.resolve({ ok: true, data: now() }),
    up: () => Promise.resolve({ ok: true, data: now() }),
    start: () => Promise.resolve({ ok: true, data: now() }),
    stop: () => Promise.resolve({ ok: true, data: now() }),
    resize: () => Promise.resolve({ ok: true, data: now() }),
    terminate: () => Promise.resolve({ ok: true, data: now() }),
  };
  const link: BoxLink = {
    run: () => Promise.resolve(typeof ran === 'function' ? ran() : ran),
    follow: () => ({ stop: () => undefined, ended: Promise.resolve(255) }),
    attach: () => [],
    forward: () =>
      Promise.resolve({ ok: false, error: { code: 'no-forward', message: 'not in this test' } }),
  };

  const f = startBoxFront({
    boxes,
    link,
    clock,
    sleep: () => {
      clock.tick(1000);

      return Promise.resolve();
    },
    emit: journal(clock).emit,
    ...(bootMs === undefined ? {} : { bootMs }),
  });

  return Object.assign(f, { clock });
};

const Failure = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});

const SILENT =
  'box demo-shop-1 is running · serve not answering · 2 min · still booting? try again in a minute; abe box status demo-shop-1 says when it answers';

describe('abe --on <box> to a box whose serve does not answer yet (#143)', () => {
  test('said running, its serve not answering, how long, and the next step; exit 3', async () => {
    const f = front(NO_SERVE);
    const json = await f.forward('demo-shop-1', ['session', 'list', '--json'], true);

    expect(json.exit).toBe(3);
    expect(Failure.parse(JSON.parse(json.stdout)).error).toEqual({
      code: 'box-unreachable',
      message: SILENT,
    });
    expect(await f.forward('demo-shop-1', ['session', 'list'], false)).toEqual({
      exit: 3,
      stdout: '',
      stderr: `abe: ${SILENT}\n`,
    });
    f.close();
  });

  test('the link failing on a box that runs: its words, never told to wake', async () => {
    const f = front({ exit: 255, stdout: '', stderr: 'ssh: connect to host: no route to host\n' });
    const out = await f.forward('demo-shop-1', ['status'], false);

    expect(out).toEqual({
      exit: 3,
      stdout: '',
      stderr:
        'abe: box demo-shop-1 is running · cannot be reached: ssh: connect to host: no route to host · try again; abe box status demo-shop-1 says whether it answers\n',
    });
    f.close();
  });

  test('the link failing because the box went to sleep meanwhile: EC2 read again, said asleep', async () => {
    // Running when woken, stopped when read again after the link failed.
    const f = front({ exit: 255, stdout: '', stderr: 'ssh: connection closed\n' }, [
      'running',
      'stopped',
    ]);
    const out = await f.forward('demo-shop-1', ['status'], false);

    expect(out.stderr).toBe(
      'abe: box demo-shop-1 is stopped · abe box start demo-shop-1 wakes it\n',
    );
    f.close();
  });

  test('a serve that answered and then went: not answering since then, not booting', async () => {
    let up = true;
    const f = front(() =>
      up ? { exit: 0, stdout: '{"ok":true,"data":{}}\n', stderr: '' } : NO_SERVE,
    );

    expect((await f.forward('demo-shop-1', ['status', '--json'], true)).exit).toBe(0);
    up = false;
    f.clock.tick(MIN);
    await f.forward('demo-shop-1', ['status'], false);
    f.clock.tick(3 * MIN);
    expect((await f.forward('demo-shop-1', ['status'], false)).stderr).toBe(
      'abe: box demo-shop-1 is running · serve not answering · 3 min · abe box attach demo-shop-1 -- journalctl -u abe-serve says why; abe box stop demo-shop-1, then abe box start demo-shop-1 boots it again\n',
    );
    f.close();
  });

  test('a box stuck starting past its boot time: said starting, in the same words', async () => {
    const f = front(NO_SERVE, ['pending'], 0);
    const out = await f.forward('demo-shop-1', ['status'], false);

    expect(out.stderr).toMatch(
      /^abe: box demo-shop-1 is starting · \d+ min · try again in a minute; abe box status demo-shop-1 says when it runs\n$/,
    );
    f.close();
  });

  test("the box's own answer, a refusal too, goes through as it printed it", async () => {
    const refusal = {
      exit: 1,
      stdout: '{"ok":false,"error":{"code":"no-session","message":"no session 1-ab"}}\n',
      stderr: '',
    } as const;
    const f = front(refusal);

    expect(await f.forward('demo-shop-1', ['session', 'show', '1-ab'], true)).toEqual(refusal);
    f.close();
  });
});

describe('abe box status and session list say the same', () => {
  test('box status: serve silent, its reach and when it was read; its line says why', async () => {
    const f = front(NO_SERVE);
    const shown = await f.status('demo-shop-1');

    expect(shown.ok && shown.data).toMatchObject({
      state: 'running',
      serve: 'silent',
      reach: { kind: 'silent', since: new Date(T0 - 2 * MIN).toISOString() },
      readAt: new Date(T0).toISOString(),
    });
    // In words: its line, then where it stands, as --on says it.
    expect(shown.ok && boxText(shown.data)).toBe(
      `demo-shop-1  booting · serve not answering yet  m8g.large  $0.00 today\n  ${SILENT}\n`,
    );
    f.close();
  });

  test('box list while a stop is under way: EC2 read again says stopping, so the box is stopping, no problem (#235)', async () => {
    // Listed running; its serve already gone with the stop, EC2 read again: stopping.
    const f = front({ exit: 255, stdout: '', stderr: 'ssh: connection closed\n' }, [
      'running',
      'stopping',
    ]);
    const listed = await f.list();
    const shown = listed.ok ? listed.data.boxes[0] : undefined;

    expect(shown).toMatchObject({ state: 'stopping', serve: null, workspace: null });
    expect(shown?.reach).toBeUndefined();
    expect(shown === undefined ? '' : boxText(shown)).toBe(
      'demo-shop-1  stopping  m8g.large  $0.00 today\n',
    );
    f.close();
  });

  test('box list while a stop is under way and its serve went first (exit 3): stopping, its time up kept (#235)', async () => {
    // Its link still answers, its serve is already gone: the box's own abe exits 3.
    const f = front(NO_SERVE, ['running', 'stopping']);
    const listed = await f.list();
    const shown = listed.ok ? listed.data.boxes[0] : undefined;

    expect(shown).toMatchObject({ state: 'stopping', serve: null });
    expect(shown?.reach).toBeUndefined();
    // first seen here: up from its LaunchTime 2 minutes ago until now, then down
    expect(shown?.costToday?.minutes).toBe(2);
    f.close();
  });

  test('box list while a terminate is under way: shutting down, never a running problem', async () => {
    const f = front({ exit: 255, stdout: '', stderr: 'ssh: connection closed\n' }, [
      'running',
      'shutting-down',
    ]);
    const listed = await f.list();

    expect(listed.ok && listed.data.boxes[0]).toMatchObject({
      state: 'shutting-down',
      serve: null,
    });
    expect(listed.ok && listed.data.boxes[0]?.reach).toBeUndefined();
    f.close();
  });

  test("box status of a box the link cannot reach: unreachable, with the link's words", async () => {
    const f = front({ exit: 255, stdout: '', stderr: 'no route to box demo-shop-1\n' });
    const shown = await f.status('demo-shop-1');

    expect(shown.ok && shown.data.reach).toEqual({
      kind: 'unreachable',
      why: 'no route to box demo-shop-1',
    });
    f.close();
  });

  test("its sshd not up yet (the endpoint's `Unable to connect to target`): booting, never the tunnel's words (#244)", async () => {
    const SSHD_DOWN: Ran = {
      exit: 255,
      stdout: '',
      stderr:
        'abe box tunnel: open-tunnel: closed: Unable to connect to target\nConnection closed by UNKNOWN port 65535\n',
    };
    const f = front(SSHD_DOWN);
    const shown = await f.status('demo-shop-1');

    expect(shown.ok && shown.data.reach).toEqual({
      kind: 'silent',
      since: box().launchedAt ?? null,
    });
    expect(await f.forward('demo-shop-1', ['status'], false)).toEqual({
      exit: 3,
      stdout: '',
      stderr: `abe: ${SILENT}\n`,
    });
    // session list's note (the Sessions tab) in the same words
    expect((await f.sessions()).notes).toEqual([SILENT]);
    f.close();
  });

  test('a refused tunnel (the login, the rights) is no boot: its words stay', async () => {
    const why =
      'abe box tunnel: open-tunnel: handshake refused (HTTP 403) (no right to open a tunnel to this box)';
    const f = front({ exit: 255, stdout: '', stderr: `${why}\n` });
    const shown = await f.status('demo-shop-1');

    expect(shown.ok && shown.data.reach).toEqual({ kind: 'unreachable', why });
    f.close();
  });

  // #213 B4: a launch waiting for its serve says `Box booting`; the list (Linked, the Boxes tab) agrees
  test.each([
    [
      'while this serve waits for it in its boot: booting',
      true,
      { kind: 'silent', since: box().launchedAt ?? null },
    ],
    [
      "after the wait: the link's words",
      false,
      { kind: 'unreachable', why: 'no route to box demo-shop-1' },
    ],
  ] as const)('box list of a box the link cannot reach %s', async (_, inBoot, reach) => {
    const f = front({ exit: 255, stdout: '', stderr: 'no route to box demo-shop-1\n' });
    const listed = inBoot
      ? await f.booting('demo-shop-1', () => f.list())
      : await f.booting('demo-shop-1', () => Promise.resolve()).then(() => f.list());

    expect(listed.ok && listed.data.boxes[0]?.reach).toEqual(reach);
    f.close();
  });

  test("session list: the box that did not answer is the note, in the same words as --on's", async () => {
    const f = front(NO_SERVE);
    const listed = await f.sessions();

    expect(listed).toEqual({ sessions: [], unread: null, notes: [SILENT] });
    // In words: a line each.
    expect(sessionListNote({ sessions: [], boxes: [SILENT, SILENT].join('\n') })).toBe(
      `abe: ${SILENT}\nabe: ${SILENT}\n`,
    );
    f.close();
  });
});
