/**
 * Local sessions' browsers (#182): one per local Factory run's session, as a box's workspace has
 * one, run by the Mac's `serve` outside the session's sandbox (Chrome does not start inside it).
 * Its DevTools port is picked at the launch and kept in `<state>/browsers/<id>/port`, so the MCP
 * config the session's `claude` starts with points at it before any browser runs; `abe browser
 * start|stop|status` from the session then drive that session's own (`startBrowserService`, the
 * workspace's rules: idle stop, profiles, verification's end), and its end stops it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  type Browser,
  BROWSER,
  type Clock,
  type EventData,
  LOCAL_BROWSER,
  localBrowserMcpConfig,
  localChromeArgv,
  type ProfileStore,
} from '@abe/core';
import { sessionDir } from '@abe/ports';
import { type BrowserService, startBrowserService } from '../browser/browser';

export type LocalBrowserOptions = {
  /** The Browser port on this Mac (`chromiumBrowser` through a local shell, `directDevtools`). */
  browser: Browser;
  /** The Chrome to run; null: none installed, so no session gets a browser. */
  executable: string | null;
};

export type LocalBrowsers = {
  /**
   * For a launch of session `id` whose `PATH` is `path`: the MCP config its `claude` starts with
   * (given its worktree), its port picked now and kept; undefined when there is no Chrome, or no
   * `npx` on that `PATH` to run chrome-devtools-mcp with.
   */
  launch: (id: string, path: string) => Promise<((worktree: string) => string) | undefined>;
  /** The session's browser, when it was launched with one. */
  of: (id: string) => BrowserService | undefined;
  /** Sessions with a browser folder, as on disk: one ended may have left its browser running. */
  leftBehind: () => string[];
  /** The session ended: its browser stopped and its folder removed. */
  end: (id: string) => Promise<void>;
  close: () => void;
};

/** A free loopback port, as the system picks one now. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;

      server.close(() => {
        resolve(port);
      });
    });
  });

export const startLocalBrowsers = (
  o: LocalBrowserOptions & {
    stateDir: string;
    clock: Clock;
    profiles?: ProfileStore | undefined;
    every?: number;
    started: (data: EventData<'browser.started'>) => void;
    stopped: (data: EventData<'browser.stopped'>) => void;
  },
): LocalBrowsers => {
  const services = new Map<string, BrowserService>();
  const dirOf = (id: string) => LOCAL_BROWSER.dir(o.stateDir, id);
  const portFile = (id: string) => join(dirOf(id), 'port');
  // Beside its settings, in the session's own folder: its `claude` reads it at its start.
  const mcpFile = (id: string) => join(sessionDir(o.stateDir, id), 'mcp.json');
  const portOf = (id: string) => {
    const port = Number(existsSync(portFile(id)) ? readFileSync(portFile(id), 'utf8') : '');

    return Number.isInteger(port) && port > 0 ? port : undefined;
  };
  const executable = o.executable;

  const of = (id: string) => {
    const known = services.get(id);

    if (known !== undefined || executable === null) return known;
    const port = portOf(id);

    if (port === undefined) return undefined;
    const service = startBrowserService({
      browser: o.browser,
      clock: o.clock,
      every: o.every ?? BROWSER.pollMs,
      profiles: o.profiles,
      started: o.started,
      stopped: o.stopped,
      ready: () => Promise.resolve({ ok: true, data: undefined }),
      local: {
        dir: dirOf(id),
        port,
        argv: (dir, p) => localChromeArgv(executable, dir, p),
        mcpConfig: mcpFile(id),
      },
    });

    services.set(id, service);

    return service;
  };

  return {
    launch: async (id, path) => {
      const npx = Bun.which('npx', { PATH: path });

      if (executable === null || npx === null) return undefined;
      const port = await freePort();

      mkdirSync(dirOf(id), { recursive: true, mode: 0o700 });
      writeFileSync(portFile(id), String(port));

      return (worktree) => {
        const cwd = join(o.stateDir, 'browsers');
        const text = `${JSON.stringify(localBrowserMcpConfig({ port, npx, worktree, cwd }), null, 2)}\n`;

        mkdirSync(sessionDir(o.stateDir, id), { recursive: true, mode: 0o700 });
        writeFileSync(mcpFile(id), text, { mode: 0o600 });

        return mcpFile(id);
      };
    },
    of,
    leftBehind: () => {
      const dir = join(o.stateDir, 'browsers');

      return existsSync(dir) ? readdirSync(dir) : [];
    },
    end: async (id) => {
      const service = of(id);

      if (service !== undefined) {
        await service.stop('session-ended');
        service.close();
      }
      services.delete(id);
      rmSync(dirOf(id), { recursive: true, force: true });
    },
    close: () => {
      for (const s of services.values()) s.close();
      services.clear();
    },
  };
};
