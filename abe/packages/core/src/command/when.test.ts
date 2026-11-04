/**
 * Times in the Mac's zone from an absolute instant, across tonight's DST change: 25 Oct 2026,
 * 03:00 CEST → 02:00 CET (01:00 UTC), so the hour from 02:00 comes twice.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { localClock, localWhen, screenClock, screenWhen } from '.';

const zoneWas = process.env.TZ;

// bun test runs on UTC with no TZ set
const use = (zone: string | undefined) => {
  process.env.TZ = zone ?? 'UTC';
};

describe('a clock names its zone when a DST change lies between it and now', () => {
  beforeEach(() => {
    use('Europe/Stockholm');
  });
  afterEach(() => {
    use(zoneWas);
  });

  const BEFORE = Date.parse('2026-10-25T00:31:00Z'); // 02:31 CEST
  const AFTER = Date.parse('2026-10-25T01:30:00Z'); // 02:30 CET

  test.each<[string, string, number | undefined, string]>([
    ['before the change, now before', '2026-10-25T00:55:00Z', BEFORE, '02:55'],
    [
      'after the change, now before: its own zone named',
      '2026-10-25T01:00:00Z',
      BEFORE,
      '02:00 CET',
    ],
    ['after the change, now before', '2026-10-25T01:08:00Z', BEFORE, '02:08 CET'],
    ['before the change, now after', '2026-10-25T00:55:00Z', AFTER, '02:55 CEST'],
    ['after the change, now after', '2026-10-25T01:08:00Z', AFTER, '02:08'],
    ['no now: the clock as it was then', '2026-10-25T01:08:00Z', undefined, '02:08'],
  ])('%s', (_, at, now, shown) => {
    expect(localClock(at, now)).toBe(shown);
  });

  test('every time from its instant: the order you read is the order they come in', () => {
    const at = ['2026-10-25T00:55:00Z', '2026-10-25T01:00:00Z', '2026-10-25T01:08:00Z'];

    expect(at.map((t) => localClock(t, BEFORE))).toEqual(['02:55', '02:00 CET', '02:08 CET']);
  });

  test('with its date too: another day, or the other side of the change', () => {
    expect(localWhen('2026-10-25T00:55:00Z', AFTER)).toBe('02:55 CEST');
    expect(localWhen('2026-10-24T10:00:00Z', AFTER)).toBe('24 Oct 12:00 CEST');
    expect(localWhen('2026-10-25T01:08:00Z', AFTER)).toBe('02:08');
  });

  test('a screen says them the same way; a day or more off, the date says enough', () => {
    expect(screenClock('2026-10-25T01:08:00Z', BEFORE)).toBe('02:08 CET');
    expect(screenWhen('2026-10-25T00:55:00Z', AFTER)).toBe('02:55 CEST');
    expect(screenWhen('2026-10-20T10:00:00Z', AFTER)).toBe('20 Oct 12:00');
  });

  test("a UTC clock (a box) says UTC in a command's text, never a change it does not have", () => {
    use('UTC');
    expect(localClock('2026-10-25T01:08:00Z', BEFORE)).toBe('01:08 UTC');
    // a screen is this Mac's own: nothing to tell it from
    expect(screenClock('2026-10-25T01:08:00Z', BEFORE)).toBe('01:08');
  });
});
