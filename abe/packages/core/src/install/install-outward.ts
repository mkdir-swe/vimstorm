/**
 * The repo's scripts that write real systems (a deploy, an import, secrets set on GitHub), as Read
 * finds them in its package scripts and the shell scripts they run, and the rules that keep the
 * install's session from running them: refused on Just this Mac, asked on Connected. Rules only:
 * Read reads the files, serve launches.
 */
import { z } from 'zod';
import { type Install } from './install';
import { AWS_OFF_DENY, installAwsOff } from './install-aws-off';

/** A script's name word that says it writes outside (`deploy:prod`, `sync:vars`, `exportUsers`). */
export const OUTWARD_WORDS = ['deploy', 'import', 'export', 'sync', 'publish', 'release'] as const;

/** A command that writes a real system, and the words it is said by. */
const OUTWARD_COMMANDS: readonly RegExp[] = [
  /(?:^|[\s;&|(`])(a0deploy)\b/,
  /\b(terraform\s+(?:apply|destroy|import))\b/,
  /\b(gh\s+(?:secret|variable)\s+(?:set|delete|remove))\b/,
  /\b(gh\s+api)\b[^\n]*(?:-X|--method)\s*['"]?(?:POST|PUT|PATCH|DELETE)\b/i,
  /(?:^|[\s;&|(`])(aws\s+[a-z][\w-]*)/,
  // every cdk command loads the app's env and may call aws (synth, diff, deploy)
  /(?:^|[\s;&|(`])((?:npx\s+)?(?:aws-)?cdk(?=\s|$|[;&|)])(?:\s+[a-z][\w-]*)?)/,
];

/** A host on this Mac: a curl to one writes nothing outside. */
const LOOPBACK = /^(localhost|127\.[\d.]+|\[::1\]|0\.0\.0\.0)$/i;

/** A curl that writes (`-X POST`, `--request DELETE`) to a host not on this Mac, or one unsaid. */
const curlWrites = (line: string): string | undefined => {
  const verb = /\bcurl\b[^\n]*(?:-X|--request)\s*['"]?(POST|PUT|PATCH|DELETE)\b/i.exec(line)?.[1];

  if (verb === undefined) return undefined;
  const hosts = [...line.matchAll(/\bhttps?:\/\/(\[[^\]]+\]|[^/:\s'"]+)/gi)].map((m) => m[1] ?? '');

  return hosts.length > 0 && hosts.every((h) => LOOPBACK.test(h))
    ? undefined
    : `curl -X ${verb.toUpperCase()}`;
};

/** The writing command in a script's text, as said (`gh secret set`), and its line. */
const outwardAt = (text: string): { said: string; line: number } | undefined => {
  for (const [n, line] of text.split('\n').entries()) {
    if (/^\s*#/.test(line)) continue;
    for (const re of OUTWARD_COMMANDS) {
      const m = re.exec(line)?.[1];

      if (m !== undefined) return { said: m.replace(/\s+/g, ' '), line: n + 1 };
    }
    const curl = curlWrites(line);

    if (curl !== undefined) return { said: curl, line: n + 1 };
  }

  return undefined;
};

/** Hosts of the outside systems a script reaches with a token: tenants, clouds, vendors, trackers. */
const API_HOST =
  /^(?:[\w-]+\.)*(?:auth0\.com|sendgrid\.com|stripe\.com|gitlab\.com|github\.com|dev\.azure\.com|visualstudio\.com|amazonaws\.com|atlassian\.net|slack\.com|contentful\.com|datadoghq\.com|sentry\.io|googleapis\.com|twilio\.com|firebaseio\.com)$/i;

/** A tenant's management API, whatever host the environment gives it. */
const API_PATH = /\/api\/v\d+\//;

/** A vendor SDK client that signs its calls. */
const API_CLIENT = /\b(ManagementClient|AuthenticationClient|Octokit|S3Client|Stripe)\s*\(/;

/** How many lines either side of a call its credential may sit. */
const CALL_LINES = 6;

/** A credential a call carries. */
const CREDENTIAL =
  /\b(?:authorization|bearer|client_secret|access_token|api[-_]?key|private-token)\b|process\.env\.\w*(?:TOKEN|SECRET|KEY)\w*/i;

/**
 * A script's call to an outside API with a credential beside it (a GET too: it may carry personal data out to
 * a file), as said and its line; comments are not read. Undefined: none, or only this Mac's own.
 */
const outsideCallAt = (text: string): { said: string; line: number } | undefined => {
  const lines = text.split('\n').map((l) => (/^\s*(?:\/\/|#|\*|\/\*)/.test(l) ? '' : l));

  for (const [n, line] of lines.entries()) {
    // the credential rides the same call: a few lines either side
    if (!CREDENTIAL.test(lines.slice(Math.max(0, n - CALL_LINES), n + CALL_LINES + 1).join('\n')))
      continue;
    const hosts = [...line.matchAll(/\bhttps?:\/\/(\[[^\]]+\]|[^/:\s'"`$]+)/gi)].map(
      (m) => m[1] ?? '',
    );
    const host = hosts.find((h) => API_HOST.test(h));

    if (host !== undefined) return { said: `calls ${host} with a token`, line: n + 1 };
    const path = API_PATH.exec(line)?.[0];

    if (path !== undefined && !hosts.some((h) => LOOPBACK.test(h)))
      return { said: `calls an ${path.slice(0, -1)} endpoint with a token`, line: n + 1 };
    const client = API_CLIENT.exec(line)?.[1];

    if (client !== undefined) return { said: `calls the ${client} API with a token`, line: n + 1 };
  }

  return undefined;
};

/** The writing command in a script's text, as said (`gh secret set`); undefined: none. */
export const outwardCommand = (text: string): string | undefined => outwardAt(text)?.said;

/** The word of `name` (its parts, camelCase split too) that says it writes outside. */
export const outwardWord = (name: string): string | undefined => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);

  return OUTWARD_WORDS.find((w) => words.includes(w));
};

export const OutwardScript = z.object({
  /** A package script's name (`sync:vars`), else null: a script file (`file`). */
  name: z.string().nullable(),
  /** The folder its package.json is in: `.` the top, else a workspace's. */
  dir: z.string(),
  /** A script file it runs, or the file by itself (`scripts/exportUsers.js`), from the top. */
  file: z.string().nullable(),
  /** Where it was seen, file and line (`package.json:7`). */
  seen: z.string(),
  /** Why: its name's word (`deploy`) or the command it runs (`gh secret set`). */
  why: z.string(),
});
export type OutwardScript = z.infer<typeof OutwardScript>;

const lineOf = (text: string, at: number): number => text.slice(0, at).split('\n').length;

/** A file a command runs: `node scripts/x.js`, `./deploy.sh`, `tsx scripts/sync.ts`. */
const RUN_FILE =
  /(?:^|[\s;&|(=])((?:\.{1,2}\/)?[\w@./-]+\.(?:sh|js|mjs|cjs|ts|mts|py))(?=$|[\s;&|)"'])/g;

/** A script file's name. */
export const SCRIPT_FILE = /\.(sh|js|mjs|cjs|ts|mts|py)$/;

const joined = (dir: string, path: string): string => {
  const parts: string[] = [];

  for (const p of `${dir === '.' ? '' : `${dir}/`}${path}`.split('/'))
    if (p === '..') parts.pop();
    else if (p !== '' && p !== '.') parts.push(p);

  return parts.join('/');
};

/** The script files commands run (`node scripts/x.js`, `./deploy.sh`), from the top; `dir`: where they run. */
export const runFiles = (commands: readonly string[], dir: string): string[] => [
  ...new Set(
    commands.flatMap((c) => [...c.matchAll(RUN_FILE)].map((m) => joined(dir, m[1] ?? ''))),
  ),
];

/**
 * The scripts that write outside, from each package.json's scripts (`packages`: its folder, its
 * text, its scripts) and the files the read shell scripts are (`files`): a script whose name says
 * so, runs such a command, or runs a file whose name or text says so; and a file at the top or in
 * a workspace whose name says so (`names`, from the top).
 */
export const outwardScripts = (o: {
  packages: readonly { dir: string; text: string; scripts: Readonly<Record<string, string>> }[];
  files: ReadonlyMap<string, string>;
  names: readonly string[];
}): OutwardScript[] => {
  const out: OutwardScript[] = [];
  const fileWhy = (path: string): string | undefined => {
    const text = o.files.get(path);
    const command = text === undefined ? undefined : (outwardAt(text) ?? outsideCallAt(text));

    if (command !== undefined) return `${path}:${command.line} ${command.said}`;
    const word = outwardWord(path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''));

    return word === undefined ? undefined : `its name says ${word}`;
  };

  for (const p of o.packages)
    for (const [name, command] of Object.entries(p.scripts)) {
      const at = p.text.indexOf(`"${name}"`);
      const seen = `${p.dir === '.' ? '' : `${p.dir}/`}package.json:${lineOf(p.text, Math.max(0, at))}`;
      const runs = [...command.matchAll(RUN_FILE)].map((m) => joined(p.dir, m[1] ?? ''));
      const ran = runs.map((f) => ({ f, why: fileWhy(f) })).find((r) => r.why !== undefined);
      const word = outwardWord(name);
      const said = outwardCommand(command);
      const why = word === undefined ? (said ?? ran?.why) : `its name says ${word}`;

      if (why !== undefined)
        out.push({ name, dir: p.dir, file: ran?.f ?? runs[0] ?? null, seen, why });
    }
  for (const path of o.names) {
    if (!SCRIPT_FILE.test(path) || out.some((s) => s.file === path)) continue;
    const why = fileWhy(path);

    if (why !== undefined) out.push({ name: null, dir: '.', file: path, seen: path, why });
  }

  return out;
};

/**
 * A URL on this Mac's own host (localhost, 127.0.0.1, ::1; no scheme: curl's http), its port and
 * path after; none with a user part (`localhost@elsewhere`).
 */
const OWN_URL = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

/** curl's options that only shape the request, each with whether a value follows it. */
const OWN_CURL_OPTIONS: ReadonlyMap<string, boolean> = new Map([
  ...['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary'].map(
    (o): [string, boolean] => [o, true],
  ),
  ...['--data-urlencode', '--json', '-F', '--form', '-u', '--user', '-A', '--user-agent'].map(
    (o): [string, boolean] => [o, true],
  ),
  ...['-m', '--max-time', '--connect-timeout', '-w', '--write-out'].map((o): [string, boolean] => [
    o,
    true,
  ]),
  ...['-s', '--silent', '-S', '--show-error', '-i', '--include', '-v', '--verbose', '-f'].map(
    (o): [string, boolean] => [o, false],
  ),
  ...['--fail', '--fail-with-body', '-k', '--insecure', '-G', '--get', '--compressed'].map(
    (o): [string, boolean] => [o, false],
  ),
]);

/** A command's words, quotes taken off; undefined when it holds more than one command. */
const shellWords = (command: string): string[] | undefined => {
  const words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;

  for (const c of command) {
    if (quote !== undefined) {
      // a double quote's `$(…)`, backticks and escapes are still the shell's
      if (quote === '"' && /[$`\\]/.test(c)) return undefined;
      if (c === quote) quote = undefined;
      else word = (word ?? '') + c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= '';
    } else if (/[;&|<>$`()\\\n\r]/.test(c)) return undefined;
    else if (/\s/.test(c)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? '') + c;
  }
  if (quote !== undefined) return undefined;
  if (word !== undefined) words.push(word);

  return words;
};

/**
 * Whether a command is one curl to this Mac's own app: every URL on a loopback host (localhost,
 * 127.0.0.1, ::1), nothing else in the command, and only options that shape the request (none
 * that sends it elsewhere, follows a redirect or writes a file). Just this Mac asks no write of it.
 */
export const ownCurl = (command: string): boolean => {
  const [curl, ...rest] = shellWords(command) ?? [];
  const urls: string[] = [];

  if (curl !== 'curl') return false;
  for (let at = 0; at < rest.length; at++) {
    const w = rest[at] ?? '';
    const long = w.startsWith('--') ? w.split('=')[0] : undefined;

    if (long !== undefined) {
      const valued = OWN_CURL_OPTIONS.get(long);

      if (valued === undefined) return false;
      if (valued && !w.includes('=')) at++;
    } else if (w.startsWith('-') && w.length > 1) {
      // short flags run together (`-sS`), the last one's value attached (`-XPOST`) or next
      for (let n = 1; n < w.length; n++) {
        const valued = OWN_CURL_OPTIONS.get(`-${w[n] ?? ''}`);

        if (valued === undefined) return false;
        if (valued) {
          if (n === w.length - 1) at++;
          break;
        }
      }
    } else urls.push(w);
  }

  return urls.length > 0 && urls.every((u) => OWN_URL.test(u));
};

/**
 * A local-mode card session's guards from its checkout's install record (none: no install): aws
 * off while the install never checked it. The repo's writing scripts and tools are no longer
 * refused: a session reaches the enabled environments in full, the others not at all (ADR 0029).
 */
export const localModeGuards = (i: Install | undefined): { deny: string[]; awsOff: boolean } => {
  const awsOff = i !== undefined && installAwsOff(i) !== null;

  return { deny: awsOff ? [...AWS_OFF_DENY] : [], awsOff };
};
