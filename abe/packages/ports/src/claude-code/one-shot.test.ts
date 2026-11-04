/** The `claude -p` adapter against the fake `claude`: its answer, its failures, its timeout. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeClaude, type FakeClaude, oneShotCalls, scriptOneShot } from '@abe/testing';
import { claudeOneShot } from './one-shot';

describe('claudeOneShot', () => {
  let claude: FakeClaude;
  let home: string;
  const ask = (o: { timeoutMs?: number; path?: string } = {}) =>
    claudeOneShot().ask({
      prompt: 'Sort these.',
      system: 'Be brief.',
      model: 'haiku',
      cwd: home,
      env: { HOME: home, PATH: o.path ?? claude.path, TERM: 'xterm-256color' },
      timeoutMs: o.timeoutMs ?? 10_000,
    });

  beforeAll(() => {
    claude = fakeClaude();
    home = mkdtempSync(join(tmpdir(), 'one-shot-'));
  });

  afterAll(() => {
    claude.remove();
    rmSync(home, { recursive: true, force: true });
  });

  test('the prompt on stdin, exactly the env given, its text back', async () => {
    scriptOneShot(home, { answers: ['{"n": 1}'] });

    expect(await ask()).toEqual({ ok: true, data: { text: '{"n": 1}\n' } });
    const [call] = oneShotCalls(home);

    expect(call?.prompt).toBe('Sort these.');
    expect(call?.argv.slice(0, 3)).toEqual(['-p', '--model', 'haiku']);
    expect(
      Object.keys(call?.env ?? {})
        .filter((n) => n !== '__CF_USER_TEXT_ENCODING')
        .sort(),
    ).toEqual(['HOME', 'PATH', 'TERM']);
  });

  test('an exit other than 0 is one-shot-failed, with what it printed', async () => {
    scriptOneShot(home, { answers: ['Not logged in'], exit: 1 });

    expect(await ask()).toEqual({
      ok: false,
      error: { code: 'one-shot-failed', message: 'claude -p exited 1: Not logged in' },
    });
  });

  test('past its time it is killed: one-shot-timeout', async () => {
    scriptOneShot(home, { answers: ['late'], sleep: 5000 });

    expect(await ask({ timeoutMs: 300 })).toMatchObject({
      ok: false,
      error: { code: 'one-shot-timeout' },
    });
  });

  test('no claude on its PATH: no-claude', async () => {
    expect(await ask({ path: '/usr/bin:/bin' })).toMatchObject({
      ok: false,
      error: { code: 'no-claude' },
    });
  });
});
