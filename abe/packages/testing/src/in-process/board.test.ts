/** `fakeBoard` behind an in-process `serve`, as a scenario that reads and writes cards gets it. */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CardData, CardDetail, CardListData, envelope } from '@abe/core';
import { card, fakeBoard } from './board';
import { scenario, type ServeScenario } from './serve';

const BOARD = 'board: { organization: https://dev.azure.com/demo-org, project: Shop, team: Web }\n';

/** The repo's settings (ADR 0031: its abe.yaml) in the scenario's folder, a checkout, holding `text`. */
const settings = (s: ServeScenario, text: string) => {
  const dir = join(s.state.dir, '.abe');

  mkdirSync(join(s.state.dir, '.git'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(s.state.dir, 'abe.yaml'), text);
  writeFileSync(join(dir, 'settings.local.yaml'), '');
};

const data = <T extends Parameters<typeof envelope>[0]>(schema: T, stdout: string) =>
  envelope(schema).parse(JSON.parse(stdout));

describe('fakeBoard', () => {
  test('lists, shows, comments on, tags and moves cards, and the next read sees each write', async () => {
    const board = fakeBoard(
      [
        card(1, 'Pay by card', { assignee: { name: 'Alex', email: 'alex@example.test' } }),
        card(2, 'Order history', { tags: ['web'] }),
      ],
      { me: { name: 'Alex', email: 'alex@example.test' }, states: ['New', 'Active'] },
    );
    await using s = await scenario({ board });

    settings(s, BOARD);
    writeFileSync(join(s.state.dir, 'c.md'), 'Ready to build.\n');
    const mine = data(CardListData, (await s.request('card', 'list', '--mine', '--json')).stdout);
    const tagged = data(
      CardData,
      (await s.request('card', 'tag', '2', '--add', 'needs-info', '--json')).stdout,
    );
    const moved = await s.request('card', 'move', '2', 'Done', '--json');

    await s.request('card', 'comment', '1', '--body-file', 'c.md', '--json');
    await s.request('card', 'move', '1', 'Active', '--json');
    const shown = data(CardDetail, (await s.request('card', 'show', 'AB#1', '--json')).stdout);

    expect(mine).toMatchObject({ ok: true, data: { cards: [{ id: 1 }] } });
    expect(tagged).toMatchObject({ ok: true, data: { tags: ['web', 'needs-info'] } });
    expect(moved.exit).toBe(1);
    expect(shown).toMatchObject({
      ok: true,
      data: { state: 'Active', comments: [{ text: 'Ready to build.', by: 'Alex' }] },
    });
    expect(board.cards().map((c) => c.state)).toEqual(['Active', 'New']);
  });

  test("lists as the board's query: a lane and a tag the repo leaves out, a card in no lane kept", async () => {
    const board = fakeBoard([
      card(1, 'Pay by card'),
      card(2, 'Ship to lockers', { lane: 'External dependencies' }),
      card(3, 'Gift wrap', { lane: 'Expedite' }),
      card(4, 'Order history', { tags: ['Blocked'] }),
    ]);
    await using s = await scenario({ board });

    settings(
      s,
      'board: { organization: https://dev.azure.com/demo-org, project: Shop, team: Web, excludeLanes: [External dependencies], notTag: blocked }\n',
    );
    const listed = data(CardListData, (await s.request('card', 'list', '--json')).stdout);

    expect(listed.ok && listed.data.cards.map((c) => [c.id, c.lane ?? null])).toEqual([
      [1, null],
      [3, 'Expedite'],
    ]);
  });
});
