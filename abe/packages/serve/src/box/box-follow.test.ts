/**
 * A followed box's events merged into the Mac's stream (#56), through `startBoxFront` with a fake
 * `Boxes` and a fake `BoxLink` whose `watch` sends the lines a box's would: a box that could not
 * hand on every event since the last one the Mac got (its ring moved on during a long drop, or
 * its serve started again) says `watch.gap`, and the Mac's watchers are told so, tagged with the
 * box, rather than missing those events in silence.
 */
import { expect, test } from 'bun:test';
import { type Box, type BoxLink, type Event, journal } from '@abe/core';
import { fakeClock, until } from '@abe/testing';
import { startBoxFront } from './boxes';

const BOX: Box = {
  id: 'i-0123456789abcdef0',
  name: 'demo-shop-4',
  owner: 'octocat',
  state: 'running',
  size: 'm8g.large',
  zone: 'eu-west-1a',
  privateIp: '10.0.0.4',
  vpc: null,
  subnet: null,
  repo: 'mkdir-swe/demo-shop',
  card: 4,
};

const AT = new Date(0).toISOString();

const line = (seq: number, type: string, data: unknown) =>
  JSON.stringify({ seq, at: AT, type, data });

test("a box's watch.gap reaches the Mac's watchers, tagged; its command log does not", async () => {
  const clock = fakeClock();
  const events = journal(clock);
  const seen: Event[] = [];
  const asked: string[][] = [];
  const unwatch = events.watch(undefined, (e) => {
    seen.push(e);
  });
  const link: BoxLink = {
    run: () =>
      Promise.resolve({ exit: 0, stdout: '{"ok":true,"data":{"sessions":[]}}\n', stderr: '' }),
    follow: (_box, argv, onLine) => {
      asked.push([...argv]);
      // Its serve started again: the Mac's last number is ahead of it, so it says so first.
      onLine(line(1, 'watch.gap', { since: 7, first: 1 }));
      onLine(line(1, 'command.ran', { noun: 'status', verb: null, exit: 0 }));
      onLine(
        line(2, 'session.state', {
          id: '4-a1b2',
          card: 4,
          state: 'working',
          since: AT,
          cause: 'UserPromptSubmit',
        }),
      );

      return { stop: () => undefined, ended: new Promise<number>(() => undefined) };
    },
    attach: () => [],
    forward: () =>
      Promise.resolve({ ok: false, error: { code: 'no-forward', message: 'not in this test' } }),
  };
  const front = startBoxFront({
    boxes: {
      list: () => Promise.resolve({ ok: true, data: [BOX] }),
      status: () => Promise.resolve({ ok: true, data: BOX }),
      up: () => Promise.resolve({ ok: true, data: BOX }),
      start: () => Promise.resolve({ ok: true, data: BOX }),
      stop: () => Promise.resolve({ ok: true, data: BOX }),
      resize: () => Promise.resolve({ ok: true, data: BOX }),
      terminate: () => Promise.resolve({ ok: true, data: BOX }),
    },
    link,
    clock,
    sleep: () => Promise.resolve(),
    emit: events.emit,
  });

  try {
    front.keep(BOX.name, 'cloud');
    await until('the session state merged', () =>
      seen.some((e) => e.type === 'session.state') ? true : undefined,
    );
    expect(asked).toEqual([['watch', '--json']]);
    expect(seen.map((e) => [e.type, e.box, e.data])).toEqual([
      ['watch.gap', BOX.name, { since: 7, first: 1 }],
      [
        'session.state',
        BOX.name,
        { id: '4-a1b2', card: 4, state: 'working', since: AT, cause: 'UserPromptSubmit' },
      ],
    ]);
  } finally {
    unwatch();
    front.close();
  }
});
