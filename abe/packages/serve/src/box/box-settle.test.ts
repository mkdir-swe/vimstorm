import { describe, expect, test } from 'bun:test';
import { type Box, type Boxes, type BoxState } from '@abe/core';
import { type SettleDeps, settleBox, startBox } from './box-settle';

const box = (state: BoxState): Box => ({
  id: 'i-0b1',
  name: 'shop-4',
  owner: 'octocat',
  state,
  size: 'm8g.large',
  zone: 'eu-west-1a',
  privateIp: null,
  vpc: null,
  subnet: null,
  repo: null,
  card: null,
});

/** Boxes reading `states` in turn (the last one again), on a clock each poll moves by a second. */
const world = (states: readonly (BoxState | null)[]) => {
  let at = 0;
  let read = 0;
  const started: string[] = [];
  const unused = () => Promise.reject(new Error('unused'));
  const boxes: Boxes = {
    list: unused,
    status: () => {
      const state = states[Math.min(read, states.length - 1)] ?? null;

      read += 1;

      return Promise.resolve({ ok: true, data: state === null ? null : box(state) });
    },
    up: unused,
    start: (name) => {
      started.push(name);

      return Promise.resolve({ ok: true, data: box('pending') });
    },
    stop: unused,
    resize: unused,
    terminate: unused,
  };
  const d: SettleDeps = {
    boxes,
    now: () => at,
    sleep: (ms) => {
      at += ms;

      return Promise.resolve();
    },
    pollMs: 1000,
  };

  return { d, started, reads: () => read };
};

describe('settleBox: EC2 read again until the box is up or down', () => {
  test('there once EC2 says so', async () => {
    const w = world(['pending', 'pending', 'running']);

    expect(await settleBox(w.d, 'shop-4', 'running', 60_000)).toMatchObject({
      ok: true,
      data: { state: 'running' },
    });
    expect(w.reads()).toBe(3);
  });

  test('going away is box-failed, at once', async () => {
    const w = world(['pending', 'shutting-down']);

    expect(await settleBox(w.d, 'shop-4', 'running', 60_000)).toEqual({
      ok: false,
      error: { code: 'box-failed', message: 'box shop-4 is shutting-down' },
    });
  });

  test('just made: not listed yet is waited for', async () => {
    const w = world([null, null, 'running']);

    expect((await settleBox(w.d, 'shop-4', 'running', 60_000, true)).ok).toBe(true);
  });

  test('past its time: box-timeout', async () => {
    const w = world(['stopping']);

    expect(await settleBox(w.d, 'shop-4', 'stopped', 3000)).toEqual({
      ok: false,
      error: { code: 'box-timeout', message: 'box shop-4 is not stopped after 3 s' },
    });
  });
});

describe('startBox: a sleeping box started and waited for', () => {
  test('a stop in progress ends first, then it is started', async () => {
    const w = world(['stopping', 'stopping', 'stopped', 'pending', 'running']);

    expect((await startBox(w.d, 'shop-4', 60_000)).ok).toBe(true);
    expect(w.started).toEqual(['shop-4']);
  });

  test('one coming already is not started again', async () => {
    const w = world(['pending', 'running']);

    expect((await startBox(w.d, 'shop-4', 60_000)).ok).toBe(true);
    expect(w.started).toEqual([]);
  });

  test('none by the name: no-box', async () => {
    const w = world([null]);

    expect(await startBox(w.d, 'shop-4', 60_000)).toMatchObject({
      ok: false,
      error: { code: 'no-box' },
    });
  });
});
