/**
 * Verification's browser (#66): one headless Chromium per workspace, in the workspace container
 * (the session's), started on demand by `abe browser start`, stopped by `abe browser stop`, when
 * verification ends, or after `BROWSER.idleMs` with no DevTools activity. The session reaches it
 * through chrome-devtools-mcp, handed to that session only by the MCP config `browserMcpConfig`.
 * `serve` runs these rules through the Browser port.
 */
import { z } from 'zod';
import { type BrowserProbe } from '../ports';
import { SOCKET_MOUNT, WORKSPACE_MOUNT } from '../box/workspace';

export const BROWSER = {
  /**
   * DevTools' port, on 127.0.0.1 inside the workspace container's own network namespace: two
   * workspaces never share it, and nothing outside the container reaches it.
   */
  port: 9222,
  /** In the container's own filesystem: the pid file, the log and `profile/`, made anew per start. */
  dir: '/home/abe/.cache/abe/browser',
  executable: '/usr/bin/chromium',
  /** No DevTools activity for this long stops it. */
  idleMs: 10 * 60_000,
  /** How often `serve` reads DevTools for activity. */
  pollMs: 60_000,
  /** The session's MCP config, as the workspace sees it (the socket's mounted directory). */
  mcpConfig: `${SOCKET_MOUNT}/mcp.json`,
} as const;

export const profileOf = (dir: string): string => `${dir}/profile`;

export const endpointOf = (port: number): string => `http://127.0.0.1:${port}`;

/**
 * Headless Chromium with its own profile and DevTools port. Its sandbox stays on (the workspace's
 * seccomp profile allows it): the agent runs untrusted page JavaScript. Nothing that calls Google.
 */
export const chromiumArgv = (executable: string, dir: string, port: number): string[] => [
  executable,
  '--headless',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileOf(dir)}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--no-pings',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--disable-breakpad',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--metrics-recording-only',
  '--disable-features=Translate,MediaRouter,OptimizationHints,OptimizationGuideModelDownloading,OptimizationHintsFetching,AutofillServerCommunication',
  '--password-store=basic',
  '--mute-audio',
  '--hide-scrollbars',
  '--window-size=1280,800',
  'about:blank',
];

/**
 * The MCP config the session's `claude` is launched with (`--mcp-config`): chrome-devtools-mcp
 * attached to this workspace's Chromium. It connects on its first tool call and again after a
 * restart of the browser, so it is handed over before any browser runs. No usage statistics, no
 * CrUX (it would send the page's URLs to Google), pages addressed without ids. Its files (a
 * screenshot's `filePath`) only under the workspace volume: without a root it allows only the
 * temp directory, so `.scratch/<card>/verify/` would be refused.
 */
export const browserMcpConfig = (
  port: number = BROWSER.port,
  o: { command: string; args: readonly string[]; workspace: string } = {
    command: 'chrome-devtools-mcp',
    args: [],
    workspace: WORKSPACE_MOUNT,
  },
) => ({
  mcpServers: {
    'chrome-devtools': {
      type: 'stdio' as const,
      command: o.command,
      args: [
        ...o.args,
        `--browserUrl=${endpointOf(port)}`,
        '--no-page-id-routing',
        '--usageStatistics=false',
        '--performanceCrux=false',
        `--workspace=${o.workspace}`,
      ],
      // No npm update check, no usage statistics, no config file read from the repo.
      env: {
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
        CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: '1',
      },
    },
  },
});

/** The chrome-devtools-mcp a box's image installs (`images/base/Dockerfile`), the Mac's through npx. */
export const CHROME_DEVTOOLS_MCP = 'chrome-devtools-mcp@1.11.0';

/**
 * A local session's browser (#182): the Mac's Google Chrome, headless, started by `serve` outside
 * the session's sandbox on a port picked at the session's launch, its profile in `serve`'s state
 * (`<state>/browsers/<id>`). The keychain is a mock one: no dialog, none of the person's secrets.
 */
export const LOCAL_BROWSER = {
  executables: (home: string): string[] =>
    ['/Applications', `${home}/Applications`].flatMap((apps) => [
      `${apps}/Google Chrome.app/Contents/MacOS/Google Chrome`,
      `${apps}/Chromium.app/Contents/MacOS/Chromium`,
    ]),
  dir: (stateDir: string, id: string): string => `${stateDir}/browsers/${id}`,
} as const;

/** `chromiumArgv` for the Mac's Chrome: its keychain a mock one. */
export const localChromeArgv = (executable: string, dir: string, port: number): string[] => {
  const argv = chromiumArgv(executable, dir, port);

  return [...argv.slice(0, -1), '--use-mock-keychain', ...argv.slice(-1)];
};

/**
 * A local session's MCP config: chrome-devtools-mcp through `npx` (the pinned version) on its own
 * browser's port, its files (a screenshot's `filePath`) under the session's worktree only. npx
 * runs from `cwd` (serve's state), never the worktree: a package the agent put in the worktree's
 * `node_modules` is never the one that runs.
 */
export const localBrowserMcpConfig = (o: {
  port: number;
  npx: string;
  worktree: string;
  cwd: string;
}) =>
  browserMcpConfig(o.port, {
    command: '/bin/sh',
    args: ['-c', 'cd "$0" && exec "$@"', o.cwd, o.npx, '-y', CHROME_DEVTOOLS_MCP],
    workspace: o.worktree,
  });

/** Why a browser stopped: `abe browser stop`, verification's end, idleness, or on its own. */
export const BrowserStopReason = z.enum(['stop', 'verified', 'idle', 'exited', 'session-ended']);
export type BrowserStopReason = z.infer<typeof BrowserStopReason>;

const iso = z.iso.datetime();

/** `abe browser start|stop|status`: the workspace's browser, and where DevTools answers. */
export const BrowserData = z.object({
  state: z.enum(['running', 'stopped']),
  /** DevTools' HTTP endpoint inside the workspace (`/json/version`); `null` while stopped. */
  endpoint: z.string().nullable(),
  /** The browser's DevTools WebSocket (what M4's live view streams from); `null` while stopped. */
  webSocket: z.string().nullable(),
  /** As DevTools names it: `Chrome/156.0.8078.47`. */
  browser: z.string().nullable(),
  pid: z.number().int().positive().nullable(),
  /** Open pages. */
  pages: z.number().int().nonnegative(),
  /** DevTools clients connected (chrome-devtools-mcp once it has been used, a live view). */
  clients: z.number().int().nonnegative(),
  port: z.number().int().positive(),
  profile: z.string(),
  /** The MCP config handed to this workspace's session. */
  mcpConfig: z.string(),
  startedAt: iso.nullable(),
  lastActivityAt: iso.nullable(),
  /** When it stops unless DevTools sees activity first. */
  idleStopAt: iso.nullable(),
  /** The last stop this `serve` saw. */
  stopped: z.object({ at: iso, reason: BrowserStopReason }).nullable(),
  /**
   * The browser profile it runs in (#103): `default` (empty, 2.0's) or one whose sign-ins were
   * restored into it at its start; `null` while stopped, or for a browser this `serve` did not start.
   */
  browserProfile: z.string().nullable().default(null),
  /** When the restored copy of its sign-ins was stored (`abe browser store`), and how long ago. */
  signIns: z.object({ storedAt: iso, ago: z.string() }).nullable().default(null),
});
export type BrowserData = z.infer<typeof BrowserData>;

/** `HH:MM` of an RFC 3339 time (UTC). */
const hhmm = (at: string) => at.slice(11, 16);

const pages = (n: number) => (n === 1 ? '1 page' : `${n} pages`);

/** The profile line of a running browser: none for the built-in `default` (2.0's text). */
const profileLine = (b: BrowserData) =>
  b.browserProfile === null || b.browserProfile === 'default'
    ? ''
    : `${b.browserProfile} · ${b.signIns === null ? 'signed in' : `signed in from a copy stored ${b.signIns.ago}`} (cookies and local storage only)\n`;

export const browserText = (b: BrowserData): string => {
  if (b.state === 'running')
    return `${b.browser ?? 'browser'} running at ${b.endpoint ?? '?'} (pid ${b.pid ?? '?'}, ${pages(b.pages)})${b.idleStopAt === null ? '' : `, idle stop at ${hhmm(b.idleStopAt)} UTC`}\n${profileLine(b)}`;

  return b.stopped === null
    ? 'no browser running\n'
    : `no browser running (stopped ${hhmm(b.stopped.at)} UTC: ${b.stopped.reason})\n`;
};

/**
 * What counts as DevTools activity: the open pages (each one's id, URL and title) and how many
 * clients are connected. A change of either is activity; the same reading for `idleMs` is idle,
 * even with chrome-devtools-mcp still connected (a session that forgot `abe browser stop`).
 */
export const activityOf = (p: BrowserProbe): string =>
  JSON.stringify([p.clients, p.pages.map((page) => [page.id, page.url, page.title])]);

/**
 * Whether the session's browser ran since `since` (a run's start, #319): it runs now, or its last
 * stop came after. Unknown (`undefined`) when the `serve` reading it has watched only since
 * `watched`, after the run started: a stop before its restart is one it never saw.
 */
export const browserRanSince = (
  b: BrowserData,
  since: string,
  watched: string,
): boolean | undefined => {
  if (
    b.state === 'running' ||
    (b.stopped !== null && Date.parse(b.stopped.at) >= Date.parse(since))
  )
    return true;

  return Date.parse(watched) > Date.parse(since) ? undefined : false;
};

export const isIdle = (lastActivity: number, now: number): boolean =>
  now - lastActivity >= BROWSER.idleMs;
