/**
 * The box serve's routes to a card's workspace (ADR 0022): the session runner by the session's
 * id, every running workspace asked for what runs, and Docker not answering never read as none.
 */
import { describe, expect, test } from 'bun:test';
import { type Answered, type SessionRunner } from '@abe/core';
import { fakeDocker } from '@abe/testing';
import { routedRunner } from './box-routes';

/** A card's workspace container as `workspace up` labels it. */
const workspace = (docker: ReturnType<typeof fakeDocker>, card: string, state = 'running') =>
  docker.containersByName.set(`abe-ws-${card}`, {
    state,
    spec: {
      name: `abe-ws-${card}`,
      image: 'abe-workspace-x:latest',
      labels: { 'abe.role': 'workspace', 'abe.card': card, 'abe.branch': `card/${card}` },
      env: {},
      mounts: [],
      network: 'abe-net',
    },
  });

/** A card's runner that says which card it is and what runs there. */
const runnerOf =
  (calls: string[], running: Record<string, Answered<string[]> | Error> = {}) =>
  (card: string): SessionRunner => ({
    abe: 'abe',
    bin: '/usr/local/bin',
    socket: (id) => ({
      listen: `/state/workspaces/${card}/s/${id}`,
      session: '/run/abe',
      mode: 0o666,
    }),
    launch: () => Promise.resolve({ ok: false, error: { code: 'x', message: card } }),
    baseWorktree: (_, branch) => {
      calls.push(`base ${card} ${branch}`);

      return Promise.resolve({ ok: true, data: { path: card, base: 'b', against: 'main' } });
    },
    send: (id) => {
      calls.push(`send ${card} ${id}`);

      return Promise.resolve({ ok: true, data: null });
    },
    keys: () => Promise.resolve({ ok: true, data: null }),
    screen: () => Promise.resolve({ ok: true, data: card }),
    attach: (id) => ['attach', card, id],
    stop: () => Promise.resolve({ ok: true, data: null }),
    running: () => {
      const r = running[card] ?? { ok: true, data: [`${card}-0000`] };

      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
    attached: () => Promise.resolve(card === '102'),
  });

describe('the session runner routed by card', () => {
  test("a session's calls go to its own card's workspace, by its id", async () => {
    const docker = fakeDocker();
    const calls: string[] = [];
    const r = routedRunner({ docker, runnerOf: runnerOf(calls) });

    await r.send('101-ab12', 'hi');
    await r.send('102-cd34', 'hi');
    expect(calls).toEqual(['send 101 101-ab12', 'send 102 102-cd34']);
    expect(r.socket('102-cd34').listen).toBe('/state/workspaces/102/s/102-cd34');
    expect(r.attach('101-ab12')).toEqual(['attach', '101', '101-ab12']);
    // No card in its id: refused, never another card's.
    expect((await r.screen('retro-x')).ok).toBe(false);
  });

  test("Before's worktree: the card whose clone is on the branch", async () => {
    const docker = fakeDocker();
    const calls: string[] = [];

    workspace(docker, '101');
    workspace(docker, '102');
    await routedRunner({ docker, runnerOf: runnerOf(calls) }).baseWorktree('r', 'card/102');
    expect(calls).toEqual(['base 102 card/102']);
  });

  test('what runs: every running workspace; a stopped one has none', async () => {
    const docker = fakeDocker();

    workspace(docker, '101');
    workspace(docker, '102');
    workspace(docker, '103', 'exited');
    const r = routedRunner({ docker, runnerOf: runnerOf([]) });

    expect(await r.running()).toEqual({ ok: true, data: ['101-0000', '102-0000'] });
    expect(await r.attached?.()).toBe(true);
  });

  test('Docker or a workspace not answering fails the look: no session is read as gone', async () => {
    const docker = fakeDocker();

    workspace(docker, '101');
    workspace(docker, '102');
    const thrown = routedRunner({
      docker,
      runnerOf: runnerOf([], { '102': new Error('docker exec timed out') }),
    });

    expect((await thrown.running()).ok).toBe(false);
    docker.containers = () => Promise.reject(new Error('Cannot connect to the Docker daemon'));
    const down = await routedRunner({ docker, runnerOf: runnerOf([]) }).running();

    expect(down).toMatchObject({ ok: false, error: { code: 'docker-failed' } });
  });
});
