import { describe, expect, test } from 'bun:test';
import { boxLimitMessage, boxPlaceText, type PlaceAction, placeRepo, placeWake } from './box-place';
import { boxName } from './cloud';
import { type Box, type BoxState } from '../ports';

const REPO = 'mkdir-swe/demo-shop';
const box = (name: string, state: BoxState, repo: string | null, card: number | null): Box => ({
  id: `i-${name}`,
  name,
  owner: 'octocat',
  state,
  size: 'm8g.large',
  zone: 'eu-west-1a',
  privateIp: null,
  vpc: null,
  subnet: null,
  repo,
  card,
});
/** The repo's own box (ADR 0022: a box per repo, no card tag). */
const own = (name: string, state: BoxState) => box(name, state, REPO, null);
/** Another repo's box. */
const other = (name: string, state: BoxState) => box(name, state, `mkdir-swe/other-${name}`, null);
/** An old box: a 2.2 box made for one card of this repo. */
const old = (name: string, state: BoxState) => box(name, state, REPO, 4);

describe("placeRepo: the repo's box, Queued at the team limit (running and starting boxes count)", () => {
  test.each<[string, Box[], number, number, PlaceAction | 'refused']>([
    ['its box running', [own('x', 'running')], 1, 0, 'use'],
    [
      'its box running, others at the limit',
      [own('x', 'running'), other('a', 'running')],
      2,
      0,
      'use',
    ],
    ['its box starting', [own('x', 'pending')], 1, 0, 'use'],
    ['its box asleep, room for it', [own('x', 'stopped'), other('a', 'running')], 2, 0, 'wake'],
    [
      'its box asleep, at the limit: a wake counts once it starts',
      [own('x', 'stopped'), other('a', 'running')],
      1,
      0,
      'queue',
    ],
    ['its box asleep, requests waiting ahead go first', [own('x', 'stopped')], 1, 3, 'queue'],
    ['its box stopping', [own('x', 'stopping')], 1, 0, 'wake'],
    ['no box yet', [], 1, 0, 'create'],
    ['no box, under the limit', [other('a', 'running')], 2, 0, 'create'],
    ['no box, at the limit', [other('a', 'running'), other('bb', 'running')], 2, 0, 'queue'],
    [
      'no box, a starting box counts',
      [other('a', 'running'), other('bb', 'pending')],
      2,
      0,
      'queue',
    ],
    [
      'no box, stopped boxes do not count',
      [other('a', 'stopped'), other('bb', 'stopped')],
      2,
      0,
      'create',
    ],
    ['no box, room, but one waits ahead', [other('a', 'running')], 2, 1, 'queue'],
    ['no box, room past those ahead', [other('a', 'running')], 3, 1, 'create'],
    ['a terminated box frees its room', [other('a', 'terminated')], 1, 0, 'create'],
    ['its box terminated: a new one', [own('x', 'terminated')], 1, 0, 'create'],
    [
      'its box by its name while it has no repo tag',
      [box(boxName(REPO), 'stopped', null, null)],
      1,
      0,
      'wake',
    ],
    ['its box being terminated', [own('x', 'shutting-down')], 3, 0, 'refused'],
    // ADR 0022: an old box is never placed on; running, it counts all the same.
    [
      'an old box of the repo running: never used, a new box made',
      [old('demo-shop-4', 'running')],
      2,
      0,
      'create',
    ],
    ['an old box running counts under the limit', [old('demo-shop-4', 'running')], 1, 0, 'queue'],
    ['an old box asleep: never woken', [old('demo-shop-4', 'stopped')], 1, 0, 'create'],
  ])('%s → %s', (_, boxes, limit, ahead, kind) => {
    expect(placeRepo({ boxes, repo: REPO, limit, ahead }).kind).toBe(kind);
  });

  test('the answer names the box (its own, else the one a create makes) and the running count', () => {
    const boxes = [
      own('shop', 'stopped'),
      other('a', 'running'),
      other('bb', 'stopped'),
      other('b', 'terminated'),
    ];

    expect(placeRepo({ boxes, repo: REPO, limit: 2, ahead: 0 })).toEqual({
      kind: 'wake',
      box: 'shop',
      count: 1,
      limit: 2,
    });
    expect(placeRepo({ boxes: [], repo: REPO, limit: 1, ahead: 0 })).toEqual({
      kind: 'create',
      box: 'demo-shop',
      count: 0,
      limit: 1,
    });
  });

  test("a new box is named for the repo; another repo's of that name gets 4 hex of the repo after it", () => {
    const theirs = box('demo-shop', 'running', 'octo/demo-shop', null);

    expect(placeRepo({ boxes: [theirs], repo: REPO, limit: 3, ahead: 0 })).toMatchObject({
      kind: 'create',
      box: boxName(REPO, true),
    });
    expect(boxName(REPO, true)).toMatch(/^demo-shop-[0-9a-f]{4}$/);
    expect(boxName('octo/demo-shop', true)).not.toBe(boxName(REPO, true));
    // A terminated one frees the name.
    expect(
      placeRepo({ boxes: [{ ...theirs, state: 'terminated' }], repo: REPO, limit: 3, ahead: 0 }),
    ).toMatchObject({ box: 'demo-shop' });
  });

  test('box names: the repo alone, cut to 32 with room for the hex, never empty', () => {
    expect(boxName('mkdir-swe/Demo Shop!')).toBe('demo-shop');
    expect(boxName('o/a-very-long-repository-name-that-goes-on-and-on')).toHaveLength(32);
    expect(boxName('o/a-very-long-repository-name-that-goes-on-and-on', true)).toHaveLength(32);
    expect(boxName('o/___')).toBe('repo');
  });

  test("the text says what counts: your running or starting boxes of the team's limit", () => {
    expect(boxPlaceText({ box: 'b', action: 'queue', boxes: 2, limit: 2, applied: true })).toBe(
      'box b: Queued until a box stops or is deleted, or the limit rises (2 of 2 running or starting, limits.maxBoxesPerPerson)\n',
    );
  });

  test.each<[PlaceAction, string]>([
    [
      'queue',
      'would queue it until a box stops or is deleted, or the limit rises (3 of 3 running or starting, limits.maxBoxesPerPerson) · --apply queues it',
    ],
    [
      'wake',
      'would wake it (1 of 3 running or starting, limits.maxBoxesPerPerson) · --apply does it',
    ],
    [
      'create',
      'would make it (1 of 3 running or starting, limits.maxBoxesPerPerson) · --apply does it',
    ],
    [
      'use',
      'would use it (it runs) (1 of 3 running or starting, limits.maxBoxesPerPerson) · --apply does it',
    ],
  ])('a dry run says what it would do, never that it did (#194): %s', (action, text) => {
    const boxes = action === 'queue' ? 3 : 1;

    expect(boxPlaceText({ box: 'b', action, boxes, limit: 3 })).toBe(`box b: ${text}\n`);
  });
});

describe('placeWake: a box woken by name (box start, Wake, --on, box keep) is placed as a launch’s wake (#191)', () => {
  test.each<[string, Box[], string, number, number, PlaceAction | 'refused' | 'none']>([
    ['running: nothing to count', [own('x', 'running'), other('a', 'running')], 'x', 1, 0, 'use'],
    ['starting: counted already', [own('x', 'pending')], 'x', 1, 0, 'use'],
    ['asleep, room for it', [own('x', 'stopped'), other('a', 'running')], 'x', 2, 0, 'wake'],
    ['asleep, at the limit', [own('x', 'stopped'), other('a', 'running')], 'x', 1, 0, 'queue'],
    ['asleep, requests Queued ahead go first', [own('x', 'stopped')], 'x', 1, 1, 'queue'],
    ['stopping, at the limit', [own('x', 'stopping'), other('a', 'running')], 'x', 1, 0, 'queue'],
    ['by its instance id', [own('x', 'stopped'), other('a', 'running')], 'i-x', 1, 0, 'queue'],
    [
      'an old box (its card tag) is woken by name the same',
      [old('x', 'stopped')],
      'x',
      1,
      0,
      'wake',
    ],
    ['being terminated', [own('x', 'shutting-down')], 'x', 1, 0, 'refused'],
    ['no such box', [other('a', 'running')], 'x', 1, 0, 'none'],
    ['terminated is no box', [own('x', 'terminated')], 'x', 1, 0, 'none'],
  ])('%s', (_, boxes, name, limit, ahead, kind) => {
    expect(placeWake({ boxes, box: name, limit, ahead })?.kind ?? 'none').toBe(kind);
  });

  test('its count and limit, as box up says them', () => {
    expect(
      placeWake({
        boxes: [own('x', 'stopped'), other('a', 'running')],
        box: 'x',
        limit: 1,
        ahead: 0,
      }),
    ).toEqual({ kind: 'queue', box: 'x', count: 1, limit: 1 });
  });
});

describe('boxLimitMessage: the refusal at the limit (box up, box start)', () => {
  test('a card: abe box place queues it', () => {
    expect(boxLimitMessage({ count: 3, limit: 3 }, { card: 3 })).toBe(
      'no room under limits.maxBoxesPerPerson 3: you have 3 running or starting (stopped ones do not count) and Queued requests go first; abe box place 3 --apply queues it',
    );
    expect(boxLimitMessage({ count: 3, limit: 3 }, { card: 3, repo: REPO })).toEndWith(
      `; abe box place 3 --repo ${REPO} --apply queues it`,
    );
  });

  test('a box without a card: stop one first', () => {
    expect(boxLimitMessage({ count: 2, limit: 2 })).toEndWith('; stop one first, then start it');
  });
});
