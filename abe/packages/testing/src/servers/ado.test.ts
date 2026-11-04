/** The fake Azure DevOps. `X-Fake-As` makes a teammate the writer, as `qarig teammate` does. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { type FakeAdo, fakeAdo } from './ado';

const Who = z.object({ uniqueName: z.string() });
const ItemJson = z.object({ rev: z.number(), fields: z.record(z.string(), z.unknown()) });
const CommentJson = z.object({ createdBy: Who });

let ado: FakeAdo;

beforeAll(async () => {
  ado = await fakeAdo();
});
afterAll(async () => {
  await ado.stop();
});

const call = (method: string, path: string, body: unknown, as?: string) =>
  fetch(`${ado.url}/demo-org/Sandbox/_apis/wit/${path}`, {
    method,
    headers: {
      authorization: 'Bearer fake-token',
      'content-type': 'application/json-patch+json',
      ...(as === undefined ? {} : { 'x-fake-as': as }),
    },
    body: JSON.stringify(body),
  });

const changedBy = (json: unknown) => Who.parse(ItemJson.parse(json).fields['System.ChangedBy']);

describe('fake Azure DevOps X-Fake-As', () => {
  test('a write as a teammate is changed by that teammate, and one without it by me', async () => {
    const move = [{ op: 'add', path: '/fields/System.State', value: 'Active' }];
    const asSam = await call('PATCH', 'workitems/2?api-version=7.1', move, 'sam');

    expect(asSam.status).toBe(200);
    expect(changedBy(await asSam.json()).uniqueName).toBe('sam@example.test');

    const byName = await call('PATCH', 'workitems/3?api-version=7.1', move, 'Robin Placeholder');

    expect(changedBy(await byName.json()).uniqueName).toBe('robin@example.test');

    const mine = await call('PATCH', 'workitems/2?api-version=7.1', move);

    expect(changedBy(await mine.json()).uniqueName).toBe('alex@example.test');
    expect(ado.requests().some((l) => l.includes('workitems/2') && l.endsWith('(as sam)'))).toBe(
      true,
    );
  });

  test("a teammate's comment is theirs", async () => {
    const res = await call(
      'POST',
      'workItems/2/comments?api-version=7.1-preview.4',
      { text: 'looks good' },
      'sam@example.test',
    );

    expect(res.status).toBe(200);
    expect(CommentJson.parse(await res.json()).createdBy.uniqueName).toBe('sam@example.test');
  });

  test('someone not on the team is refused, and nothing changes', async () => {
    const res = await call(
      'PATCH',
      'workitems/4?api-version=7.1',
      [{ op: 'add', path: '/fields/System.State', value: 'Active' }],
      'mallory',
    );

    expect(res.status).toBe(400);
    const now = await fetch(`${ado.url}/demo-org/Sandbox/_apis/wit/workitems/4?api-version=7.1`, {
      headers: { authorization: 'Bearer fake-token' },
    });

    expect(ItemJson.parse(await now.json()).rev).toBe(1);
  });
});
