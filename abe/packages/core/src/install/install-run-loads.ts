/**
 * What the start script's processes load, for the gate: the env files its commands name (a path,
 * `source`, dotenv's `-e` and `--env-file`), the ones a dotenv cascade (`-c dev`, `--mode dev`)
 * or a bare `dotenv` takes, and the ones a framework loads by itself in the folder it runs in
 * (vite, next). A package script it runs (`npm run dev`, `npm --prefix backend run dev`) is
 * followed into its own commands. An env file nothing loads is not the run's.
 */

/** The env files a framework or dotenv loads by itself, in the order a later one wins. */
export const ENV_FILES = [
  '.env',
  '.env.development',
  '.env.local',
  '.env.development.local',
] as const;

const fileName = (path: string): string => path.split('/').at(-1) ?? path;

const dirOf = (path: string): string => {
  const at = path.lastIndexOf('/');

  return at === -1 ? '.' : path.slice(0, at);
};

/** `dir` and a path from it, as a path from the top (`.` the top); null: out of the checkout. */
const joined = (dir: string, path: string): string | null => {
  if (path.startsWith('/') || path.includes('$')) return null;
  const parts = dir === '.' ? [] : dir.split('/');

  for (const p of path.split('/'))
    if (p === '..') {
      if (parts.pop() === undefined) return null;
    } else if (p !== '' && p !== '.') parts.push(p);

  return parts.length === 0 ? '.' : parts.join('/');
};

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const names = (command: string, word: string): boolean =>
  new RegExp(`(^|[^\\w.-])${escaped(word)}($|[^\\w.-])`).test(command);

/** A command that runs nothing of the app's: it loads nothing. */
const NOT_RUN =
  /^(cd|echo|printf|export|set|unset|wait|sleep|trap|mkdir|rm|kill|test|\[|true|false|exit|:|#)(\s|$)/;

/** A command that only says words: what it names is not loaded. */
const SAYS = /^(echo|printf|:)(\s|$)/;

/** A framework that loads the folder's env files itself. */
const FRAMEWORK =
  /(?:^|[\s/"'])(vite|next|nuxt|astro|remix|react-scripts|gatsby|vue-cli-service|svelte-kit|expo)(?=\s|$|["'])/;

/** dotenv run bare (`dotenv -- node x`, `-r dotenv/config`, `env-cmd`): the folder's `.env`. */
const DOTENV = /(?:^|[\s/"'])(dotenv(?:-cli)?|env-cmd)(?=\s|$)|dotenv\/config/;

/** A dotenv flag naming its file: then the bare `.env` is not taken. */
const DOTENV_FILE = /(?:^|\s)(?:-e|-f|--env-file|-c)(?:\s+|=)\S/;

/** A dotenv cascade or a framework's mode: `-c dev`, `--mode staging`. */
const CASCADE = /(?:^|\s)(?:-c|--mode|-m)(?:\s+|=)([\w-]+)(?=\s|$)/g;

/** A package script run: `npm run dev`, `yarn dev`, `pnpm --dir web dev`, `npm start`. */
const PACKAGE_RUN =
  /(?:^|[\s"'(])(?:npm|pnpm|yarn|bun)((?:\s+(?:--prefix|-C|--cwd|--dir)(?:\s+|=)\S+)?)\s+(?:run(?:-script)?\s+)?([\w:.-]+)/g;

/** The folder a package manager is told to run in (`--prefix backend`, `-w backend`). */
const PACKAGE_DIR = /(?:^|\s)(?:--prefix|-C|--cwd|--dir|-w|--workspace)(?:\s+|=)["']?([\w./-]+)/;

type Segment = { dir: string; command: string };

/** A script's commands, each with the folder it runs in (`cd` carried to the commands after it). */
const segments = (text: string, dir: string): Segment[] => {
  const out: Segment[] = [];
  let at = dir;

  for (const raw of text.split(/\n|&&|\|\||;|\|/)) {
    const command = raw.replace(/&\s*$/, '').trim();

    if (command === '') continue;
    const cd = /^cd\s+["']?([\w./-]+)["']?$/.exec(command)?.[1];

    if (cd !== undefined) at = joined(at, cd) ?? at;
    else out.push({ dir: at, command });
  }

  return out;
};

export type RunLoads = {
  /** The env files the run loads, from the top. */
  loads: Set<string>;
  /** The folders the run runs something of the app's in. */
  runs: Set<string>;
  /** The folders where the gate saw what loads env files (a name, a cascade, dotenv, a framework). */
  seen: Set<string>;
};

type Scripts = readonly { dir: string; scripts: Readonly<Record<string, string>> }[];

/** Each command the start script runs, its package scripts followed, and whether it was one. */
const visit = (start: string, scripts: Scripts, fn: (s: Segment, followed: boolean) => void) => {
  const scriptsAt = (dir: string) => scripts.find((s) => s.dir === dir)?.scripts ?? {};
  const walk = (s: Segment, depth: number) => {
    let followed = false;

    if (depth < 5)
      for (const m of s.command.matchAll(PACKAGE_RUN)) {
        const at =
          joined(s.dir, PACKAGE_DIR.exec(`${m[1] ?? ''} ${s.command}`)?.[1] ?? '.') ?? s.dir;
        const script = scriptsAt(at)[m[2] ?? ''];

        if (script === undefined) continue;
        followed = true;
        for (const inner of segments(script, at)) walk(inner, depth + 1);
      }
    fn(s, followed);
  };

  for (const s of segments(start, '.')) walk(s, 0);
};

/** A command that runs a file of the app's (`node server.js`, `tsx watch ./fastify/server.ts`). */
const RUNS_FILE =
  /(?:^|[\s"'(])(?:npx\s+)?(?:node|tsx|ts-node|ts-node-dev|nodemon|bun)(?:\s+(?:watch|run))?(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+["']?((?:\.{0,2}\/)?[\w@./-]+\.(?:[cm]?[jt]s|tsx|jsx))/g;

/** At most this many entry files are named. */
export const ENTRIES_READ = 10;

/**
 * The app's entry files the start script runs, each with the folder it runs in (its package
 * scripts followed), from the top: where code may load dotenv itself.
 */
export const runEntries = (o: {
  start: string;
  scripts: Scripts;
}): { dir: string; path: string }[] => {
  const out: { dir: string; path: string }[] = [];

  visit(o.start, o.scripts, (s) => {
    for (const m of s.command.matchAll(RUNS_FILE)) {
      const path = joined(s.dir, m[1] ?? '');

      if (path !== null && path !== '.' && !out.some((e) => e.path === path))
        out.push({ dir: s.dir, path });
    }
  });

  return out.slice(0, ENTRIES_READ);
};

/** A file's relative imports (`./config`, `../lib/env.js`), as written. */
export const codeImports = (text: string): string[] => [
  ...new Set(
    [
      ...text.matchAll(/(?:from\s+|require\(\s*|import\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g),
    ].map((m) => m[1] ?? ''),
  ),
];

/** dotenv in code: `import 'dotenv/config'`, `require('dotenv').config(…)`, `config({ path })`. */
const DOTENV_CODE =
  /(?:['"]dotenv\/config['"])|(?:\bdotenv['"]?\s*\)?\s*\.config\s*\(([^)]*)\))|(?:\bconfig\s*\(\s*(\{[^)]*path[^)]*)\))|(?:process\.loadEnvFile\s*\(([^)]*)\))/g;

/** An env file a dotenv call in code names: its string literals' last env-file-like part. */
const codeNamed = (args: string): string[] =>
  [...args.matchAll(/['"]([^'"]*\.env[^'"]*|[^'"]*\.env)['"]/g)].map((m) => m[1] ?? '');

/**
 * What `start` loads of `files` (the real env files, from the top), its package scripts followed
 * through `scripts` (each folder's package.json scripts), and what the app's code (`code`: its
 * entry files and theirs, each with the folder it runs in) loads with dotenv: the file it names,
 * from where it runs or the code's own folder, else the folder's `.env`.
 */
export const runLoads = (o: {
  start: string;
  files: readonly string[];
  scripts: Scripts;
  code?: readonly { dir: string; path: string; text: string }[];
}): RunLoads => {
  const out: RunLoads = { loads: new Set(), runs: new Set(), seen: new Set() };
  const take = (dir: string, names: readonly string[]) => {
    for (const n of names) {
      const path = dir === '.' ? n : `${dir}/${n}`;

      if (o.files.includes(path)) out.loads.add(path);
    }
    out.seen.add(dir);
  };

  visit(o.start, o.scripts, ({ dir, command }, followed) => {
    // the env files it names: by its path from the top, or from where it runs; one it only says
    // (echo, printf) is not loaded
    for (const f of SAYS.test(command) ? [] : o.files) {
      const from = dirOf(f) === dir ? fileName(f) : undefined;
      const up = dir !== '.' && dirOf(f) === '.' ? `../${fileName(f)}` : undefined;

      if ([f, from, up].some((w) => w !== undefined && names(command, w))) {
        out.loads.add(f);
        out.seen.add(dir);
      }
    }
    const cascade = [...command.matchAll(CASCADE)].map((m) => m[1] ?? '');

    if (cascade.length > 0)
      take(
        dir,
        cascade.flatMap((e) => [`.env.${e}`, `.env.${e}.local`, '.env.local', '.env']),
      );
    if (DOTENV.test(command) && !DOTENV_FILE.test(command)) take(dir, ['.env']);
    if (FRAMEWORK.test(command)) take(dir, ENV_FILES);
    if (!followed && !NOT_RUN.test(command)) out.runs.add(dir);
  });
  for (const c of (o.code ?? []).filter((c) => /dotenv|loadEnvFile/.test(c.text)))
    for (const m of c.text.matchAll(DOTENV_CODE)) {
      const named = codeNamed(m[1] ?? m[2] ?? m[3] ?? '');

      if (named.length === 0) {
        take(c.dir, ['.env']);
        continue;
      }
      for (const n of named)
        for (const at of [joined(c.dir, n), joined(dirOf(c.path), n)])
          if (at !== null && o.files.includes(at)) out.loads.add(at);
      out.seen.add(c.dir);
    }

  return out;
};
