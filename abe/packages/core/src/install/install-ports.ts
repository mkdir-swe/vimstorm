/**
 * Factory install's Read: the repo's own dev-server ports (a vite or webpack config's dev server,
 * a port in a package script) and the places an auth redirect is the page's own origin
 * (`redirect_uri: window.location.origin`). Such a redirect is registered at the provider for the
 * repo's own port, so that port is fixed: Run locally keeps it instead of `ABE_PORT_BASE`. Pure:
 * the files' text (path → text) and the lines a bounded search found.
 */
import { z } from 'zod';

export const DevPort = z.object({
  port: z.number().int(),
  /** Where: the file and line and what was there (`web/vite.config.ts:4 server.port`). */
  seen: z.string(),
});
export type DevPort = z.infer<typeof DevPort>;

/** One line a search of the checkout found: its file, its line number, its text. */
export type FoundLine = { path: string; line: number; text: string };

/** A dev server's config, read beside a workspace's package.json and at the top. */
export const DEV_CONFIG = /^(vite|webpack(\.[\w-]+)?)\.config\.[cm]?[jt]s$/;

/**
 * An auth redirect that is the page's origin: `redirect_uri`, `redirectUri`, `returnTo` or a
 * callback URL set from `location.origin`, on one line. Both JavaScript's and `git grep -E -i`'s.
 */
export const ORIGIN_AUTH_PATTERN =
  '(redirect_?ur[il]|return_?to|callback_?ur[il])["\']? *[:=][^;]{0,80}location\\.origin';

/** At most this many such lines are kept. */
export const ORIGIN_AUTH_READ = 10;

const lineOf = (text: string, at: number): number => text.slice(0, at).split('\n').length;
const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** A port a person would pick for a dev server, not a version or a count. */
const port = (s: string | undefined): number | null => {
  const n = Number(s);

  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
};

/** In a config: the dev server block's `port:` (vite's `server`, webpack's `devServer`). */
const CONFIG_PORT: readonly { file: RegExp; re: RegExp; what: string }[] = [
  { file: /^vite\./, re: /\bserver\s*:\s*\{[\s\S]{0,400}?\bport\s*:\s*(\d+)/, what: 'server.port' },
  {
    file: /^webpack[.]/,
    re: /\bdevServer\s*:\s*\{[\s\S]{0,400}?\bport\s*:\s*(\d+)/,
    what: 'devServer.port',
  },
];

/** In a package script: `--port 4000`, `--port=4000`, `PORT=4000`, next's `-p 4000`. */
const SCRIPT_PORT = /(?:--port[= ]|\bPORT=|\bnext\s+(?:dev|start)\b[^&;|]*?\s-p\s+)(\d+)/;

/**
 * A script that runs a tool beside the app (a database studio, storybook, an inspector): its port
 * is the tool's, never the app's, so no sign-in redirect is bound to it.
 */
const DEV_TOOL =
  /(?:^|[\s;&|])(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn)\s+)?(?:drizzle-kit|prisma|storybook|ladle|adminer|mailhog|mailpit)\b/i;

/** A script named for a tool: `drizzle:studio`, `db-studio`, `storybook`. */
const TOOL_NAME = /(?:^|[:_-])(?:studio|storybook|ladle|swagger|redoc|typedoc)(?:$|[:_-])/i;

/** The `&&` / `;` / `|` part of a command that carries the port: the one that decides. */
const portPart = (command: string): string =>
  command.split(/&&|;|\|/).find((part) => SCRIPT_PORT.test(part)) ?? command;

const Scripts = z.object({ scripts: z.record(z.string(), z.string()).optional() });

const scriptsOf = (text: string): Record<string, string> => {
  try {
    return Scripts.safeParse(JSON.parse(text)).data?.scripts ?? {};
  } catch {
    return {};
  }
};

/** The dev-server ports the repo's configs and package scripts name, each where seen. */
export const devPortsOf = (files: ReadonlyMap<string, string>): DevPort[] => {
  const out: DevPort[] = [];

  for (const [path, text] of files) {
    const name = baseName(path);

    if (DEV_CONFIG.test(name))
      for (const c of CONFIG_PORT.filter((x) => x.file.test(name))) {
        const m = c.re.exec(text);
        const p = port(m?.[1]);

        if (m !== null && p !== null)
          out.push({ port: p, seen: `${path}:${lineOf(text, m.index)} ${c.what}` });
      }
    if (name === 'package.json')
      for (const [script, command] of Object.entries(scriptsOf(text))) {
        if (
          TOOL_NAME.test(script) ||
          DEV_TOOL.test(portPart(command)) ||
          /--inspect\b/.test(portPart(command))
        )
          continue;
        const p = port(SCRIPT_PORT.exec(command)?.[1]);

        if (p !== null)
          out.push({
            port: p,
            seen: `${path}:${lineOf(text, Math.max(0, text.indexOf(`"${script}"`)))} ${script}`,
          });
      }
  }

  return out;
};

/** The lines found where an auth redirect is the page's origin, as `path:line text`. */
export const originAuthOf = (found: readonly FoundLine[]): string[] => {
  const re = new RegExp(ORIGIN_AUTH_PATTERN, 'i');

  return found
    .filter((f) => re.test(f.text))
    .slice(0, ORIGIN_AUTH_READ)
    .map((f) => `${f.path}:${f.line} ${f.text.trim().slice(0, 100)}`);
};

/**
 * The dev ports an origin-bound auth redirect fixes: those in the folder holding it (a
 * workspace's config or package.json above it), else, none there, every one the repo names.
 */
export const originFixedPorts = (dev: readonly DevPort[], auth: readonly string[]): number[] => {
  if (auth.length === 0) return [];
  const near = dev.filter((d) => {
    const dir = dirOf(d.seen.slice(0, d.seen.indexOf(':')));

    return auth.some((a) => dir === '' || a.startsWith(`${dir}/`));
  });

  return (near.length === 0 ? dev : near).map((d) => d.port);
};
