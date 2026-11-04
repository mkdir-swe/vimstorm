/**
 * `session list`'s merges (#332): a Factory run's session says so (`SessionData.factory`) whatever
 * answered for it: its box's older serve, or a session launched before serve kept the flag.
 */
import { describe, expect, test } from 'bun:test';
import { session } from '@abe/testing';
import { markRunSessions, mergeBoxSessions } from './sessions';

describe("a Factory run's session keeps saying so (#332)", () => {
  test("its box's answer replaces what this serve kept, but never drops the flag", () => {
    const kept = { ...session('4-a1b2', 'working', 4), box: 'demo-4', factory: true as const };
    const fromBox = { ...session('4-a1b2', 'waiting', 4), box: 'demo-4' };
    const merged = mergeBoxSessions([kept], [fromBox]);

    expect(merged.map((x) => [x.state, x.factory])).toEqual([['waiting', true]]);
    // a plain one stays plain
    const plain = mergeBoxSessions(
      [{ ...session('4-a1b2', 'working', 4), box: 'demo-4' }],
      [fromBox],
    );

    expect(plain[0]?.factory).toBeUndefined();
  });

  test("a move this serve said after the box's answer (a stop, its box gone) is kept over it (#213 C7)", () => {
    const ended = {
      ...session('4-a1b2', 'ended', 4),
      box: 'demo-4',
      since: '2026-10-01T09:05:00.000Z',
    };
    const older = { ...session('4-a1b2', 'working', 4), box: 'demo-4' };

    expect(mergeBoxSessions([ended], [older]).map((x) => x.state)).toEqual(['ended']);
  });

  test('a session a stored run names (cleared ones too) is a run’s, even launched before the flag', () => {
    const marked = markRunSessions(
      [session('4-a1b2', 'ended', 4), session('5-c3d4', 'ended', 5)],
      [{ session: '4-a1b2' }],
    );

    expect(marked.map((x) => [x.id, x.factory])).toEqual([
      ['4-a1b2', true],
      ['5-c3d4', undefined],
    ]);
  });
});
