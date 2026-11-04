/**
 * No `serve` outlives its test. A test that starts one through `cli()` and then fails or times out
 * before its `close()` leaves none running once `bun test` ends, and a test process killed outright
 * leaves a serve that stops by itself.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { servesOf } from './cli';
import { until } from '../until';

const CLI = join(import.meta.dir, 'cli.ts');
const ROOT = join(import.meta.dir, '..', '..', '..', '..');

const fixture = (body: string, timeout: number) => `
import { test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { cli } from ${JSON.stringify(CLI)};

test('starts a serve, then never closes it', async () => {
  const abe = cli();
  await abe.run('status');
  writeFileSync(process.env.QARIG_STRAY_OUT ?? '', abe.state.dir);
  ${body}
}, ${timeout});
`;

const runFixture = async (body: string, timeout: number) => {
  const dir = mkdtempSync(join(tmpdir(), 'abe-stray-'));
  const file = join(dir, 'stray.test.ts');
  const out = join(dir, 'state-dir');

  writeFileSync(file, fixture(body, timeout));
  writeFileSync(out, '');
  // run from abe/ as every test run is, so its bunfig.toml preloads the cleanup
  const child = Bun.spawn([process.execPath, 'test', file], {
    cwd: ROOT,
    env: { ...process.env, QARIG_STRAY_OUT: out },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const state = readFileSync(out, 'utf8');

  rmSync(dir, { recursive: true, force: true });

  return { exit, state, log: stdout + stderr };
};

const kill = (pids: number[]) => {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone already
    }
  }
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const Left = z.object({ pid: z.number().int().positive(), dir: z.string() });

describe('a serve a test started is stopped when the test does not stop it', () => {
  test.each<[string, string, number]>([
    ['the test fails', "throw new Error('a failing test');", 20_000],
    ['the test times out', 'await new Promise(() => {});', 1_500],
  ])(
    '%s',
    async (_, body, timeout) => {
      const { exit, state, log } = await runFixture(body, timeout);
      const left = state === '' ? [] : servesOf(state);

      kill(left);
      rmSync(state, { recursive: true, force: true });
      expect(exit, log).not.toBe(0);
      expect(state, log).not.toBe('');
      expect(left, `serves of ${state} still running after bun test ended`).toEqual([]);
    },
    60_000,
  );

  test('a serve stops by itself when the test process exits before close()', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'orphan-serve.ts')], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect([exit, err.includes('no serve')]).toEqual([1, false]);
    const left = Left.parse(JSON.parse(out));

    try {
      await until('the orphaned serve to stop', () => (alive(left.pid) ? undefined : true), {
        ms: 5_000,
      });
    } finally {
      if (alive(left.pid)) process.kill(left.pid, 'SIGKILL');
      rmSync(left.dir, { recursive: true, force: true });
    }
  }, 30_000);
});
