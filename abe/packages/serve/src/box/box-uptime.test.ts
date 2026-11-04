/** The Mac's uptime log of your boxes (#104): moves only, first seen from LaunchTime, pruned. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openUptimeLog } from './box-uptime';

const H = 3_600_000;
const NOW = Date.parse('2026-10-24T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const dirs: string[] = [];
const file = () => {
  const dir = mkdtempSync(join(tmpdir(), 'uptime-'));

  dirs.push(dir);

  return join(dir, 'box-uptime.jsonl');
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the uptime log', () => {
  test('a box first seen up counts from its LaunchTime; only moves are lines; read back', () => {
    const at = file();
    const log = openUptimeLog(at, NOW);

    log.seen('shop-4', true, NOW, iso(NOW - 2 * H));
    log.seen('shop-4', true, NOW + H, iso(NOW - 2 * H));
    log.seen('shop-4', false, NOW + 2 * H);
    // Asleep when first seen: nothing to say.
    log.seen('shop-5', false, NOW);
    // Woken later: up from its new LaunchTime, never from the stale one before it went down.
    log.seen('shop-4', true, NOW + 4 * H, iso(NOW - 2 * H));
    expect(log.moves('shop-4')).toEqual([
      { up: true, at: NOW - 2 * H },
      { up: false, at: NOW + 2 * H },
      { up: true, at: NOW + 4 * H },
    ]);
    expect(log.moves('shop-5')).toEqual([]);
    expect(readFileSync(at, 'utf8').trim().split('\n')).toHaveLength(3);
    expect(openUptimeLog(at, NOW + 4 * H).moves('shop-4')).toEqual(log.moves('shop-4'));
  });

  test('lines over two days old go when it opens, but the last one before them says where it stood', () => {
    const at = file();
    const lines = [
      { box: 'shop-4', up: true, at: iso(NOW - 80 * H) },
      { box: 'shop-4', up: false, at: iso(NOW - 70 * H) },
      { box: 'shop-4', up: true, at: iso(NOW - 60 * H) },
      { box: 'shop-4', up: false, at: iso(NOW - 1 * H) },
      { box: 'shop-5', up: true, at: iso(NOW - 90 * H) },
    ];

    writeFileSync(at, `${lines.map((l) => JSON.stringify(l)).join('\n')}\nnot json\n`);
    const log = openUptimeLog(at, NOW);

    expect(log.moves('shop-4')).toEqual([
      { up: true, at: NOW - 60 * H },
      { up: false, at: NOW - 1 * H },
    ]);
    expect(log.moves('shop-5')).toEqual([{ up: true, at: NOW - 90 * H }]);
    expect(readFileSync(at, 'utf8').trim().split('\n')).toHaveLength(3);
  });
});
