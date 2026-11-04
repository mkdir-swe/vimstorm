/**
 * Google Chrome on the Mac on a browser profile's own folder (#103), IO only, 1.0's rules
 * (`app/src/abe_command/browser.rs`): `open -n [-g] -a "Google Chrome" --args --user-data-dir=<dir>
 * --remote-debugging-port=0 …`, which hands Chrome to launchd; Chrome picks the debugging port
 * and writes it first in the folder's `DevToolsActivePort`. A second start on a running folder
 * opens its URLs there; `front` raises the running one (its first tab activated through DevTools)
 * instead of a second window. Its sign-ins are read through DevTools (`readSignIns`).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type Answered, type Chrome } from '@abe/core';
import { z } from 'zod';
import { readSignIns } from './browser-devtools';

const MAC_APP = '/Applications/Google Chrome.app';
const OPEN: readonly string[] = ['open', '-n', '-a', MAC_APP, '--args'];
const FLAGS: readonly string[] = [
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
];
const START_MS = 15_000;
const POLL_MS = 200;

export type ChromeOptions = {
  /** What runs Chrome, before its flags (default `open -n -a "Google Chrome" --args`). */
  command?: readonly string[];
  /** Chrome in front; otherwise `-g` after `open -n` keeps it behind the window in front. */
  front?: boolean;
};

/** The command that starts the Chrome of `dir`, or hands `urls` to the one running on it. */
export const chromeArgv = (dir: string, urls: readonly string[], o: ChromeOptions = {}) => {
  const command = [...(o.command ?? OPEN)];
  const n = command.indexOf('-n');

  if (o.front !== true && n !== -1 && command[0] === 'open') command.splice(n + 1, 0, '-g');

  return [...command, `--user-data-dir=${dir}`, ...FLAGS, ...urls];
};

/** DevTools' HTTP endpoint the folder's `DevToolsActivePort` names, when it answers. */
const answering = async (dir: string): Promise<string | undefined> => {
  const file = join(dir, 'DevToolsActivePort');

  if (!existsSync(dir) || !existsSync(file)) return undefined;
  let port: number;

  try {
    port = Number(readFileSync(file, 'utf8').split('\n')[0]?.trim());
  } catch {
    return undefined;
  }
  if (!Number.isInteger(port) || port <= 0) return undefined;
  const endpoint = `http://127.0.0.1:${String(port)}`;

  try {
    const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });

    return res.ok ? endpoint : undefined;
  } catch {
    return undefined;
  }
};

/** Starts `argv` apart from this process: its own process group, nothing inherited, not waited on. */
const spawnApart = (argv: readonly string[]): Promise<boolean> =>
  new Promise((resolve) => {
    const [bin, ...args] = argv;

    if (bin === undefined) {
      resolve(false);

      return;
    }
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });

    child.once('error', () => {
      resolve(false);
    });
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });

const Pages = z.array(z.object({ id: z.string(), type: z.string() }));

/** Its first page's tab activated through DevTools (`/json/activate`), which raises its window. */
const activate = async (endpoint: string): Promise<'activated' | 'no-page' | 'failed'> => {
  try {
    const listed = Pages.safeParse(
      await (await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(2000) })).json(),
    );
    const page = listed.success ? listed.data.find((t) => t.type === 'page') : undefined;

    if (page === undefined) return listed.success ? 'no-page' : 'failed';
    const res = await fetch(`${endpoint}/json/activate/${encodeURIComponent(page.id)}`, {
      signal: AbortSignal.timeout(2000),
    });

    return res.ok ? 'activated' : 'failed';
  } catch {
    return 'failed';
  }
};

export const macChrome = (
  o: ChromeOptions & { startMs?: number; pollMs?: number } = {},
): Chrome => {
  const startMs = o.startMs ?? START_MS;
  const pollMs = o.pollMs ?? POLL_MS;
  const fail = (message: string) =>
    ({ ok: false, error: { code: 'chrome-failed', message } }) as const;

  return {
    running: answering,
    open: async ({
      dir,
      urls,
      front,
    }): Promise<Answered<{ endpoint: string; started: boolean }>> => {
      const running = await answering(dir);

      if (running === undefined) {
        mkdirSync(dir, { recursive: true });
        rmSync(join(dir, 'DevToolsActivePort'), { force: true });
      }
      const argv = chromeArgv(dir, urls, front === undefined ? o : { ...o, front });

      if (!(await spawnApart(argv))) return fail(`${argv.slice(0, 4).join(' ')} did not start`);
      if (running !== undefined) return { ok: true, data: { endpoint: running, started: false } };
      for (let waited = 0; waited < startMs; waited += pollMs) {
        const endpoint = await answering(dir);

        if (endpoint !== undefined) return { ok: true, data: { endpoint, started: true } };
        await Bun.sleep(pollMs);
      }

      return fail(`Chrome did not start for ${dir}`);
    },
    // a Mac Chrome with every window closed still runs: a start on its folder opens one there
    front: async ({ dir, endpoint }) => {
      const done = await activate(endpoint);

      if (done === 'activated') return { ok: true, data: null };
      if (done === 'failed') return fail(`${endpoint} did not bring ${dir}'s Chrome to the front`);
      const argv = chromeArgv(dir, [], { ...o, front: true });

      return (await spawnApart(argv))
        ? { ok: true, data: null }
        : fail(`${argv.slice(0, 4).join(' ')} did not start`);
    },
    read: readSignIns,
  };
};
