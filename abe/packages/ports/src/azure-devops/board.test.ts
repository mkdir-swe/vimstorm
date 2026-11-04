/**
 * The Board port on Azure DevOps: what it says when Azure DevOps cannot be reached (#201), and
 * what changed since the last look (#236) on the fake Azure DevOps.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADO_SEED, fakeAdo, type FakeAdo } from '@abe/testing';
import { z } from 'zod';
import { adoBoard } from './board';

const BOARD = {
  organization: 'https://dev.azure.com/demo-org',
  project: 'Sandbox',
  team: 'Sandbox',
  types: ['User Story'],
};
const tokens = { get: () => Promise.resolve({ ok: true as const, token: 'fake' }) };

test('unreachable: which address, why in words, and what to do; never the raw fetch error', async () => {
  // a port nothing listens on
  const listening = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = listening.port;
  const base = `http://127.0.0.1:${port}`;

  await listening.stop(true);
  const read = await adoBoard({ tokens, base }).list(BOARD, { mine: false });

  expect(read).toEqual({
    ok: false,
    error: {
      code: 'offline',
      message: `Azure DevOps cannot be reached at 127.0.0.1:${port}: connection refused · check the network or VPN and read it again`,
    },
  });
});

describe('changes (#236): what changed on Azure DevOps since the last look, read by the ids', () => {
  let ado: FakeAdo | undefined;

  afterEach(async () => {
    await ado?.stop();
  });

  /** Someone else's write on the board, straight to Azure DevOps. */
  const outside = (url: string, id: number, ops: unknown[]) =>
    fetch(`${url}/demo-org/Sandbox/_apis/wit/workitems/${id}?api-version=7.1`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer fake', 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify(ops),
    });

  test('the first look only finds where to start; nothing changed is one query; a change is read', async () => {
    ado = await fakeAdo();
    const board = adoBoard({ tokens, base: ado.url });
    const ref = { ...ado.board, types: ['User Story', 'Bug'] };
    const first = await board.changes(ref, null);

    expect(first).toMatchObject({ ok: true, data: { cards: [], gone: [] } });
    const at = first.ok ? first.data.at : null;

    expect(at).not.toBeNull();
    // nothing changed since: one WIQL, nothing read
    const before = ado.requests().length;
    const quiet = await board.changes(ref, at);

    // the next look starts where this query ran (Azure DevOps' asOf)
    expect(quiet).toMatchObject({ ok: true, data: { cards: [], gone: [] } });
    const after = quiet.ok ? quiet.data.at : null;

    expect(after !== null && at !== null && after > at).toBe(true);
    const asked = ado.requests().slice(before);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(
      /^POST \/demo-org\/Sandbox\/_apis\/wit\/wiql\?.*timePrecision=true.* → 200$/,
    );
    // a teammate moves #5, takes #8 for you, and closes #7 (in a sprint not the current one)
    await outside(ado.url, 5, [{ op: 'add', path: '/fields/System.State', value: 'Active' }]);
    await outside(ado.url, 8, [
      { op: 'add', path: '/fields/System.AssignedTo', value: 'alex@example.test' },
    ]);
    await outside(ado.url, 7, [{ op: 'add', path: '/fields/System.State', value: 'Closed' }]);
    const moved = await board.changes(ref, after);

    expect(moved).toMatchObject({
      ok: true,
      data: {
        cards: [
          {
            card: { id: 8, state: 'Active', assignee: { email: 'alex@example.test' } },
            mine: true,
          },
          { card: { id: 5, state: 'Active' }, mine: false },
        ],
        gone: [7],
      },
    });
    const next = moved.ok ? moved.data.at : null;

    expect(next !== null && after !== null && next > after).toBe(true);
    expect(await board.changes(ref, next)).toMatchObject({
      ok: true,
      data: { cards: [], gone: [] },
    });
  });

  test('more than 200 changed: the next look starts 1 ms before the last one read, so ties at it are read again', async () => {
    // the demo seed and 205 stories more, on the current sprint
    const seed = z
      .looseObject({ items: z.array(z.unknown()) })
      .parse(JSON.parse(readFileSync(ADO_SEED, 'utf8')));
    const more = Array.from({ length: 205 }, (_, i) => ({
      id: 100 + i,
      type: 'User Story',
      title: `Story ${100 + i}`,
      state: 'New',
      area: 'Sandbox',
      sprint: 0,
    }));
    const file = join(mkdtempSync(join(tmpdir(), 'ado-seed-')), 'seed.json');

    writeFileSync(file, JSON.stringify({ ...seed, items: [...seed.items, ...more] }));
    ado = await fakeAdo({ seed: file });
    const board = adoBoard({ tokens, base: ado.url });
    const ref = { ...ado.board, types: ['User Story'] };
    const first = await board.changes(ref, null);
    const since = first.ok ? first.data.at : null;

    // a teammate touches every one of them, oldest first
    for (const { id } of more)
      await outside(ado.url, id, [{ op: 'add', path: '/fields/System.State', value: 'Active' }]);
    const page = await board.changes(ref, since);

    if (!page.ok) throw new Error(page.error.message);
    // one look reads at most 200, the oldest changes first
    expect(page.data.cards).toHaveLength(200);
    const read = page.data.cards.map((c) => c.card.id);

    expect(Math.max(...read)).toBe(299);
    // the last one read: its change time, from Azure DevOps itself
    const last = await fetch(
      `${ado.url}/demo-org/Sandbox/_apis/wit/workitems/299?api-version=7.1`,
      { headers: { Authorization: 'Bearer fake' } },
    );
    const lastAt = z
      .object({ fields: z.object({ 'System.ChangedDate': z.string() }) })
      .parse(await last.json()).fields['System.ChangedDate'];

    expect(page.data.at).toBe(new Date(Date.parse(lastAt) - 1).toISOString());
    // the next look reads the rest, and the last one read again (the Board puts it in place again)
    const rest = await board.changes(ref, page.data.at);

    if (!rest.ok) throw new Error(rest.error.message);
    const again = rest.data.cards.map((c) => c.card.id);

    expect(again.filter((id) => id >= 299).toSorted((a, b) => a - b)).toEqual([
      299, 300, 301, 302, 303, 304,
    ]);
    // under the cap: the look after starts where its query ran, nothing left
    const after = await board.changes(ref, rest.data.at);

    expect(after).toMatchObject({ ok: true, data: { cards: [], gone: [] } });
  });
});

describe('members and assign (B2, #213): the team’s people, and whom AssignedTo is written as', () => {
  /** A stand-in Azure DevOps answering the members, who the token is and a write, keeping the requests. */
  const stub = () => {
    const seen: { method: string; path: string; body: string }[] = [];
    const server = Bun.serve({
      // 127.0.0.1, as fetched: a port 0 on the default [::] may answer nothing there (a hang)
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);

        seen.push({
          method: req.method,
          path: `${url.pathname}${url.search}`,
          body: await req.text(),
        });
        if (url.pathname.endsWith('/connectionData'))
          return Response.json({
            authenticatedUser: {
              providerDisplayName: 'Alex Example',
              properties: { Account: { $value: 'Alex@Example.test' } },
            },
          });
        if (url.pathname.endsWith('/members'))
          return Response.json({
            count: 4,
            value: [
              { identity: { displayName: 'Sam Sample', uniqueName: 'sam@example.test' } },
              { identity: { displayName: 'Alex Example', uniqueName: 'alex@example.test' } },
              {
                identity: {
                  displayName: '[Sandbox]\\Sandbox Team',
                  uniqueName: 'vstfs:///Classification/TeamProject/x',
                  isContainer: true,
                },
              },
              {
                identity: {
                  displayName: 'Gone Person',
                  uniqueName: 'gone@example.test',
                  inactive: true,
                },
              },
            ],
          });

        return Response.json({
          id: 13,
          rev: 2,
          fields: {
            'System.Title': 'A card',
            'System.State': 'New',
            'System.WorkItemType': 'User Story',
          },
        });
      },
    });

    return { seen, base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  };

  test('members: the people only (no group, no one inactive), you by your login in any case', async () => {
    const s = stub();

    try {
      const read = await adoBoard({ tokens, base: s.base }).members(BOARD);

      expect(read).toEqual({
        ok: true,
        data: [
          { name: 'Sam Sample', email: 'sam@example.test', you: false },
          { name: 'Alex Example', email: 'alex@example.test', you: true },
        ],
      });
      expect(s.seen.map((r) => r.path)).toContainEqual(
        '/demo-org/_apis/projects/Sandbox/teams/Sandbox/members?api-version=7.1&%24top=500',
      );
    } finally {
      await s.stop();
    }
  });

  test.each([
    [{ kind: 'member', login: 'sam@example.test' } as const, 'sam@example.test'],
    [{ kind: 'none' } as const, ''],
    [{ kind: 'me' } as const, 'Alex@Example.test'],
  ])('assign %o writes System.AssignedTo %p', async (who, value) => {
    const s = stub();

    try {
      const written = await adoBoard({ tokens, base: s.base }).assign(BOARD, 13, who);

      expect(written.ok).toBe(true);
      const patch = s.seen.find((r) => r.method === 'PATCH');

      expect(JSON.parse(patch?.body ?? 'null')).toEqual([
        { op: 'add', path: '/fields/System.AssignedTo', value },
      ]);
    } finally {
      await s.stop();
    }
  });
});

describe('a shared board: only the cards that are this repo’s (board.area, board.tag, board.excludeLanes, board.notTag)', () => {
  let ado: FakeAdo | undefined;

  afterEach(async () => {
    await ado?.stop();
  });

  test.each<
    [string, { area?: string; tag?: string; excludeLanes?: string[]; notTag?: string }, number[]]
  >([
    ['the whole board', {}, [4, 5, 6, 7, 8, 13]],
    ['an area path, with the areas under it', { area: 'Sandbox\\Web' }, [4, 5, 8, 13]],
    ['an area path of its own', { area: 'Sandbox\\API' }, [6, 7]],
    ['a tag', { tag: 'auth' }, [4]],
    ['an area and a tag, both', { area: 'Sandbox\\Web', tag: 'web' }, [4, 8]],
    ['a tag nothing carries', { tag: 'billing' }, []],
    // 7 waits in External dependencies, 8 is in Expedite, the rest in no lane (the default one)
    [
      'a lane left out: its cards gone, another lane’s and those in none kept',
      { excludeLanes: ['External dependencies'] },
      [4, 5, 6, 8, 13],
    ],
    ['two lanes left out', { excludeLanes: ['External dependencies', 'Expedite'] }, [4, 5, 6, 13]],
    ['a lane no card is in', { excludeLanes: ["Ops' queue"] }, [4, 5, 6, 7, 8, 13]],
    ['a tag left out', { notTag: 'web' }, [5, 6, 7, 13]],
    [
      'an area, a lane and a tag left out, together',
      { area: 'Sandbox\\Web', excludeLanes: ['Expedite'], notTag: 'checkout' },
      [4, 5],
    ],
  ])('%s', async (_, repo, ids) => {
    ado = await fakeAdo();
    const read = await adoBoard({ tokens, base: ado.url }).list(
      { ...ado.board, types: ['User Story', 'Bug'], ...repo },
      { mine: false },
    );

    expect(read.ok ? read.data.map((c) => c.id).toSorted((a, b) => a - b) : read).toEqual(ids);
  });

  test('each card says its lane (System.BoardLane); one in none has no lane', async () => {
    ado = await fakeAdo();
    const read = await adoBoard({ tokens, base: ado.url }).list(
      { ...ado.board, types: ['User Story', 'Bug'] },
      { mine: false },
    );

    if (!read.ok) throw new Error(read.error.message);
    expect(Object.fromEntries(read.data.map((c) => [c.id, c.lane ?? null]))).toEqual({
      4: null,
      5: null,
      6: null,
      7: 'External dependencies',
      8: 'Expedite',
      13: null,
    });
    expect(read.data.find((c) => c.id === 4)).not.toHaveProperty('lane');
  });

  test('changes: a card moved into a lane left out is gone; moved back, it is on the board again', async () => {
    ado = await fakeAdo();
    const board = adoBoard({ tokens, base: ado.url });
    const ref = { ...ado.board, types: ['User Story', 'Bug'], excludeLanes: ['Expedite'] };
    const lane = (id: number, value: string) =>
      fetch(`${ado?.url ?? ''}/demo-org/Sandbox/_apis/wit/workitems/${id}?api-version=7.1`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer fake', 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify([{ op: 'add', path: '/fields/System.BoardLane', value }]),
      });
    const first = await board.changes(ref, null);
    const since = first.ok ? first.data.at : null;

    await lane(5, 'Expedite');
    const into = await board.changes(ref, since);

    expect(into).toMatchObject({ ok: true, data: { cards: [], gone: [5] } });
    await lane(5, '');
    const back = await board.changes(ref, into.ok ? into.data.at : null);

    expect(back).toMatchObject({ ok: true, data: { cards: [{ card: { id: 5 } }], gone: [] } });
  });
});
