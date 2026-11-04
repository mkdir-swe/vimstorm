/**
 * Box parity's IO on the Mac (3.2.1): Claude Code's own credential store read where Claude Code
 * keeps it (the login Keychain's `Claude Code-credentials` item, through `security`, as Claude Code
 * reads it; else `~/.claude/.credentials.json`), and a sync sent into a card's workspace on stdin
 * (`BOX_SYNC_SCRIPT`). What these hold is the person's tokens and keys: never in an argv, never
 * logged, never in an answer; a failure says its exit alone.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { type Answered, type BoxSyncPort, BOX_SYNC_SCRIPT, CONTAINER } from '@abe/core';
import { type Env } from '../mac/locations';
import { failed, runProcess } from '../mac/process';

/** The Keychain item's service, as Claude Code names it (its config folder's hash when set). */
export const claudeKeychainService = (env: Env): string => {
  const dir = env.CLAUDE_CONFIG_DIR;

  return dir === undefined || dir === ''
    ? 'Claude Code-credentials'
    : `Claude Code-credentials-${createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}`;
};

/** The Keychain item's account: the user's name, as Claude Code takes it. */
const account = (env: Env): string => {
  let name = env.USER;

  try {
    name ??= userInfo().username;
  } catch {
    name = undefined;
  }

  return name !== undefined && /^[a-zA-Z0-9._-]+$/.test(name) ? name : 'claude-code-user';
};

const parsed = (text: string): unknown => {
  const t = text.trim();

  try {
    if (t.startsWith('{')) return JSON.parse(t);
    // `security` says a password that is not all printable as hex
    if (/^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0)
      return JSON.parse(Buffer.from(t, 'hex').toString('utf8'));
  } catch {
    return undefined;
  }

  return undefined;
};

/** How long a sync into a box may take (its skills, over the box's link). */
const PUSH_MS = 120_000;

export const boxSyncPort = (env: Env): BoxSyncPort => ({
  claudeStore: async () => {
    const home = env.HOME;

    if (process.platform === 'darwin') {
      const r = await runProcess(
        [
          '/usr/bin/security',
          'find-generic-password',
          '-a',
          account(env),
          '-w',
          '-s',
          claudeKeychainService(env),
        ],
        { PATH: '/usr/bin:/bin', ...(home === undefined ? {} : { HOME: home }) },
        undefined,
        10_000,
      ).catch(() => undefined);
      const doc = r?.exit === 0 ? parsed(r.stdout) : undefined;

      if (doc !== undefined) return doc;
    }
    const dir = env.CLAUDE_CONFIG_DIR ?? (home === undefined ? undefined : join(home, '.claude'));

    if (dir === undefined) return undefined;
    try {
      return parsed(await readFile(join(dir, '.credentials.json'), 'utf8'));
    } catch {
      return undefined;
    }
  },
  push: async (exec, payload): Promise<Answered<null>> => {
    const child = Bun.spawn(
      [...exec, 'sh', '-c', BOX_SYNC_SCRIPT, 'sh', CONTAINER.workdir, CONTAINER.home],
      {
        env: Object.fromEntries(
          Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
        stdin: new TextEncoder().encode(payload),
        stdout: 'ignore',
        stderr: 'ignore',
      },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, PUSH_MS);
    const exit = await child.exited.finally(() => {
      clearTimeout(timer);
    });

    return exit === 0
      ? { ok: true, data: null }
      : failed('sync-failed', `the box's workspace did not take the sync (exit ${exit})`);
  },
});
