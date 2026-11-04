/**
 * Factory install's Read: the named aws profiles a repo's scripts and CI use (`--profile dev`,
 * `AWS_PROFILE=test`, a Serverless or CDK config's `profile:`), each with the file and line it was
 * seen at. Read only lists them: it never picks one as the repo's login; Logins asks which, these
 * offered first. Pure: the files' text (path → text), as Read read them. Env files are never
 * looked in.
 */
import { z } from 'zod';

export const AwsProfileSeen = z.object({
  /** The profile's name as the repo says it (`dev`). */
  name: z.string().min(1),
  /** Where it was seen: the file and line and what was there (`backend/package.json:11 --profile dev`). */
  seen: z.array(z.string()),
});
export type AwsProfileSeen = z.infer<typeof AwsProfileSeen>;

/** A profile's name: no variable, no placeholder. */
const NAME = /^[A-Za-z0-9][\w.-]*$/;

/** One shell word: quoted, or up to the next space or shell operator. */
const WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|()"'\\]+)`;

/** A value as a shell gives it: a name, a script's argument (`$1`, `${1:-dev}`), a variable. */
type Value =
  | { name: string }
  | { arg: number; fallback: string | null }
  | { variable: string; fallback: string | null };

const valueOf = (raw: string): Value | null => {
  const v = raw.trim().replace(/^(["'])(.*)\1$/, '$2');
  const arg = /^\$(?:([1-9])|\{([1-9])(?::?-([^}]*))?\})$/.exec(v);

  if (arg !== null)
    return {
      arg: Number(arg[1] ?? arg[2]),
      fallback: NAME.test(arg[3] ?? '') ? (arg[3] ?? null) : null,
    };
  const variable = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)(?::?-([^}]*))?\})$/.exec(v);

  if (variable !== null)
    return {
      variable: variable[1] ?? variable[2] ?? '',
      fallback: NAME.test(variable[3] ?? '') ? (variable[3] ?? null) : null,
    };

  return NAME.test(v) ? { name: v } : null;
};

const isPackage = (path: string) => path === 'package.json' || path.endsWith('/package.json');
const isCi = (path: string) =>
  path.startsWith('.github/workflows/') || path === 'azure-pipelines.yml';
const isShell = (path: string) => path.endsWith('.sh');
const isServerless = (path: string) => /(^|\/)serverless\.ya?ml$/.test(path);
const isCdk = (path: string) => /(^|\/)cdk\.json$/.test(path);

/** The files a profile may be named in: package scripts, shell scripts, CI, Serverless, CDK. */
export const awsProfileFile = (path: string): boolean =>
  isPackage(path) || isCi(path) || isShell(path) || isServerless(path) || isCdk(path);

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Hit = { value: Value; where: string };

/** A line's profile words: `--profile x`, `AWS_PROFILE=x`, and in YAML `AWS_PROFILE: x`. */
const lineHits = (path: string, n: number, line: string): Hit[] => {
  const hits: Hit[] = [];
  const at = `${path}:${n}`;

  for (const m of line.matchAll(new RegExp(String.raw`--profile(?:=|\s+)(${WORD})`, 'g'))) {
    const value = valueOf(m[1] ?? '');

    if (value !== null) hits.push({ value, where: `${at} ${m[0]}` });
  }
  for (const m of line.matchAll(new RegExp(String.raw`\bAWS_PROFILE=(${WORD})`, 'g'))) {
    const value = valueOf(m[1] ?? '');

    if (value !== null) hits.push({ value, where: `${at} ${m[0]}` });
  }
  const yaml =
    isCi(path) || isServerless(path)
      ? /^\s*(?:-\s*)?(AWS_PROFILE|profile):\s*(\S+)\s*(?:#.*)?$/.exec(line)
      : null;

  if (yaml !== null && (yaml[1] === 'AWS_PROFILE' || isServerless(path))) {
    const value = valueOf(yaml[2] ?? '');

    if (value !== null) hits.push({ value, where: `${at} ${yaml[0].trim()}` });
  }
  const cdk = isCdk(path) ? /"profile"\s*:\s*"([^"]*)"/.exec(line) : null;

  if (cdk !== null && NAME.test(cdk[1] ?? ''))
    hits.push({ value: { name: cdk[1] ?? '' }, where: `${at} ${cdk[0]}` });

  return hits;
};

/** A shell file's assignments (`PROFILE=${1:-dev}`): each variable's value and where. */
const assignments = (path: string, lines: readonly string[]) => {
  const out = new Map<string, Hit>();

  for (const [i, line] of lines.entries()) {
    const m = new RegExp(
      String.raw`^\s*(?:export\s+|local\s+|readonly\s+|declare\s+)?([A-Za-z_]\w*)=(${WORD})`,
    ).exec(line);
    const value = m === null ? null : valueOf(m[2] ?? '');

    if (m !== null && value !== null && !out.has(m[1] ?? ''))
      out.set(m[1] ?? '', { value, where: `${path}:${i + 1} ${m[0].trim()}` });
  }

  return out;
};

/**
 * The named aws profiles the files use, in the order first seen, each with every place it was
 * seen. A script whose profile is its argument (`--profile "$1"`, `PROFILE=${1:-dev}`) names the
 * profiles its callers pass it (`setAwsCredentials.sh test` in a package script or CI), and its
 * default.
 */
export const awsProfilesOf = (files: ReadonlyMap<string, string>): AwsProfileSeen[] => {
  const found = new Map<string, string[]>();
  const add = (name: string, where: string) => {
    const seen = found.get(name) ?? [];

    if (!seen.includes(where)) seen.push(where);
    found.set(name, seen);
  };
  // each script whose profile is one of its arguments: the argument's place
  const byArg = new Map<string, number>();
  const texts = [...files].filter(([path]) => awsProfileFile(path));

  for (const [path, text] of texts) {
    // a package script's quotes are JSON's: `--profile \"$P\"`
    const lines = text.split('\n').map((l) => l.replace(/\\"/g, '"'));
    const vars = isShell(path) ? assignments(path, lines) : new Map<string, Hit>();
    const resolve = (hit: Hit, depth = 0): void => {
      const v = hit.value;

      if ('name' in v) {
        add(v.name, hit.where);

        return;
      }
      if (v.fallback !== null) add(v.fallback, hit.where);
      if ('arg' in v) {
        if (isShell(path) && !byArg.has(path)) byArg.set(path, v.arg);

        return;
      }
      const next = vars.get(v.variable);

      if (next !== undefined && depth < 3) resolve(next, depth + 1);
    };

    for (const [i, line] of lines.entries())
      for (const hit of lineHits(path, i + 1, line)) resolve(hit);
  }
  // the profiles each such script is called with
  for (const [script, arg] of byArg) {
    const call = new RegExp(
      String.raw`(?:^|[\s/"'])(${escaped(baseName(script))})((?:[ \t]+${WORD})*)`,
      'g',
    );

    for (const [path, text] of texts)
      for (const [i, raw] of text.split('\n').entries()) {
        const line = raw.replace(/\\"/g, '"');

        for (const m of line.matchAll(call)) {
          const args = [...(m[2] ?? '').matchAll(new RegExp(WORD, 'g'))].map((a) => a[0]);
          const value = valueOf(args[arg - 1] ?? '');

          if (value !== null && 'name' in value)
            add(value.name, `${path}:${i + 1} ${`${m[1] ?? ''}${m[2] ?? ''}`.trim()}`);
        }
      }
  }

  return [...found].map(([name, seen]) => ({ name, seen }));
};

/**
 * The shell scripts the commands run (`bash ./scripts/creds.sh dev`), as paths from the checkout's
 * top: `dir` is the folder they run in (a workspace's), `''` the top. None outside the checkout.
 */
export const scriptPaths = (commands: readonly string[], dir: string): string[] => {
  const out: string[] = [];

  for (const c of commands)
    for (const m of c.matchAll(/(?:^|[\s;&|(=])((?:\.{1,2}\/)?[\w@./-]*\.sh)(?=$|[\s;&|)"'])/g)) {
      const path = normalized(`${dir === '' ? '' : `${dir}/`}${m[1] ?? ''}`);

      if (path !== null && !out.includes(path)) out.push(path);
    }

  return out;
};

/** `a/./b/../c` as `a/c`; null when it leaves the checkout or is absolute. */
const normalized = (path: string): string | null => {
  if (path.startsWith('/')) return null;
  const parts: string[] = [];

  for (const p of path.split('/')) {
    if (p === '' || p === '.') continue;
    if (p !== '..') parts.push(p);
    else if (parts.pop() === undefined) return null;
  }

  return parts.length === 0 ? null : parts.join('/');
};
