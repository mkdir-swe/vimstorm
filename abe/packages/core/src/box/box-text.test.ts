/** A box's state in words (#213 B4): one table, a booting box `booting`. */
import { describe, expect, test } from 'bun:test';
import { BOX_STATE_WORDS, boxBusy, boxBusyKey, boxScreenWords } from './box-text';

const T0 = Date.parse('2026-10-25T10:00:00.000Z');
const min = (n: number) => T0 + n * 60_000;
const at = (n: number) => new Date(min(n)).toISOString();

describe('boxScreenWords', () => {
  test('EC2 states say the table; a running box whose serve answers is running', () => {
    expect(boxScreenWords({ state: 'pending', launchedAt: at(0), serve: null }, min(1))).toBe(
      'starting',
    );
    expect(boxScreenWords({ state: 'running', launchedAt: at(0), serve: 'answers' }, min(1))).toBe(
      'running',
    );
    expect(boxScreenWords({ state: 'stopped', launchedAt: null, serve: null }, min(1))).toBe(
      BOX_STATE_WORDS.stopped,
    );
  });

  test('running with its serve silent in its boot: booting; past the boot: running (a problem the screens say)', () => {
    const boot = { state: 'running' as const, launchedAt: at(0), serve: 'silent' as const };

    expect(boxScreenWords(boot, min(2))).toBe('booting');
    expect(boxScreenWords(boot, min(14))).toBe('booting');
    expect(boxScreenWords(boot, min(16))).toBe('running');
    // a link refused is never a boot
    expect(
      boxScreenWords({ ...boot, reach: { kind: 'unreachable', why: 'HTTP 403' } }, min(2)),
    ).toBe('running');
  });
});

describe('boxBusy (ADR 0022): memory used or CPU at 85 % or more at a load read', () => {
  test.each<[string, number, number, boolean]>([
    ['calm', 8000, 20, false],
    ['memory 85 % used', 2400, 20, true],
    ['memory just under', 2401, 20, false],
    ['CPU 85 %', 8000, 85, true],
    ['CPU 84 %', 8000, 84, false],
  ])('%s', (_, availableMb, cpuPercent, busy) => {
    expect(boxBusy({ memory: { availableMb, totalMb: 16_000 }, cpuPercent })).toBe(busy);
  });

  test('said once a day: the key is the box and the local day', () => {
    expect(boxBusyKey('demo-shop', min(0))).toBe(boxBusyKey('demo-shop', min(60)));
    expect(boxBusyKey('demo-shop', min(0))).not.toBe(boxBusyKey('demo-shop', min(24 * 60)));
    expect(boxBusyKey('demo-shop', min(0))).not.toBe(boxBusyKey('api', min(0)));
  });
});
