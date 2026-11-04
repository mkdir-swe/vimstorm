/**
 * The Abe env files' prefill (ADR 0028): the install's session judges which of the repo's env
 * files feeds which environment, from evidence (scripts, README and CLAUDE.md, CI, key names, file
 * names, in that order), and records it with `abe install env-map`; this module is the rest, with
 * no judgement. Each environment's file gets the files feeding it in load order, the way the
 * repo's own loader would: a base first, its stage's overlay on top (the last one setting a key
 * wins). A key ending `_DEV`, `_TEST` or `_PROD` goes to its own environment only, from any file
 * used. Old copies and empty files are left out, and so are cloud credential keys an aws profile
 * covers. Each file's part is a block between `# --- from <file> · <evidence>` and
 * `# --- end <file>`; the person's own lines outside the blocks stay as they are when the blocks
 * are written again. A file the session can't place is Not sure: it asks the person, then maps it.
 */
import { z } from 'zod';
import { refused, type Outcome } from '../command';
import { AbeEnv, ABE_ENVS, isAbeEnvFile } from './credentials';
import { AWS_CREDENTIAL_KEYS, parseEnvFile } from './install-gate';

/** Where a repo env file goes: the environments it feeds, not used, or not sure. */
export const EnvFileTo = z.union([
  z.array(AbeEnv).min(1),
  z.literal('not-used'),
  z.literal('not-sure'),
]);
export type EnvFileTo = z.infer<typeof EnvFileTo>;

/** One repo env file in the mapping: where it goes and why (its evidence, or why not). */
export const EnvFileMapped = z.object({
  /** From the main checkout's top. */
  path: z.string(),
  to: EnvFileTo,
  /** The evidence it feeds those environments (`backend/package.json:11 dotenv -c dev`), or why not. */
  why: z.string(),
  by: z.enum(['session', 'person']),
  /** Why the session was not sure of it, kept once the person placed it; null: it was sure. */
  notSure: z.string().nullable().default(null),
});
export type EnvFileMapped = z.infer<typeof EnvFileMapped>;

/** Environments that live only in CI: the keys CI sets for them (names only) and where. */
export const EnvMappingCi = z.object({ keys: z.array(z.string()), evidence: z.string() });
export type EnvMappingCi = z.infer<typeof EnvMappingCi>;

/** The session's judgement, kept as a decision in the install record (`envFiles.mapping`). */
export const EnvMapping = z.object({
  /** Load order: a base before its overlay. */
  files: z.array(EnvFileMapped),
  ci: EnvMappingCi.nullable(),
  by: z.enum(['session', 'person']),
  at: z.string(),
});
export type EnvMapping = z.infer<typeof EnvMapping>;

/** How `--file` is written: `<file> -> <dev,test,prod | not-used | not-sure>: <evidence or why>`. */
export const ENV_MAP_FORM = '<file> -> <dev,test,prod | not-used | not-sure>: <evidence or why>';

/** A key name, as a dotenv file and CI name one. */
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One `--file` of `abe install env-map`, read; refused with its form when it is not one. */
export const envFileSpec = (spec: string): Outcome<Omit<EnvFileMapped, 'by' | 'notSure'>> => {
  const m = /^\s*(\S+)\s*->\s*([a-z,\s-]+?)\s*:\s*(.*\S)\s*$/.exec(spec);
  const usage = (why: string) => refused('usage', `--file "${spec}": ${why} (${ENV_MAP_FORM})`, 2);

  if (m === null) return usage('not in its form');
  const [, path = '', words = '', why = ''] = m;

  if (path.startsWith('/') || path.split('/').includes('..'))
    return usage('a file in the checkout, from its top');
  if (isAbeEnvFile(path)) return usage('an Abe env file is what it fills, never a source');
  if (words === 'not-used' || words === 'not-sure')
    return { ok: true, data: { path, to: words, why } };
  const envs = words.split(',').map((w) => w.trim());
  const bad = envs.filter((e) => !AbeEnv.safeParse(e).success);

  if (bad.length > 0) return usage(`${bad.join(', ')}: none of ${ABE_ENVS.join(', ')}`);

  return {
    ok: true,
    data: { path, to: ABE_ENVS.filter((e) => envs.includes(e)), why },
  };
};

/** CI's keys as `--ci-key` names them; refused when one is no key name. */
export const ciKeysOk = (keys: readonly string[]): Outcome<string[]> => {
  const bad = keys.filter((k) => !KEY.test(k));

  return bad.length === 0
    ? { ok: true, data: [...new Set(keys)] }
    : refused('usage', `--ci-key ${bad.join(', ')}: a key name, never a value`, 2);
};

/** Old copies by their name's words: `.env.dev.old`, `.env.bak`, `.env.orig`, `.env~`. */
const OLD_WORDS = new Set(['old', 'bak', 'backup', 'orig', 'copy', 'save', 'saved', 'prev', 'tmp']);

/** Whether a repo env file is an old copy, by its name: left out, never fed. */
export const isOldEnvCopy = (path: string): boolean => {
  const name = path.split('/').at(-1) ?? path;

  return name.endsWith('~') || name.split(/[._-]+/).some((w) => OLD_WORDS.has(w.toLowerCase()));
};

/** The environment a key's suffix names (`PAY_URL_TEST`: test); undefined: none. */
export const suffixEnv = (key: string): AbeEnv | undefined => {
  const m = /_(DEV|TEST|PROD)$/.exec(key);

  return m === null ? undefined : AbeEnv.parse(m[1]?.toLowerCase());
};

/** One block of an Abe env file: the file it came from, its head line's words, its lines. */
export type AbeEnvBlock = { source: string; head: string; lines: string[] };

/** What the prefill makes of a mapping: each environment's blocks, Not sure, left out and why. */
export type AbeEnvPrefill = {
  blocks: Record<AbeEnv, AbeEnvBlock[]>;
  notSure: { path: string; why: string }[];
  left: { path: string; why: string }[];
};

/** A `KEY=value` line as a dotenv loader reads it back: quoted when a value needs it. */
const envLine = (key: string, value: string): string => {
  if (/^[^\s#'"]+$/.test(value)) return `${key}=${value}`;

  return value.includes("'") ? `${key}="${value}"` : `${key}='${value}'`;
};

const named = (keys: readonly string[]) => keys.join(', ');

/** An environment's names as CI says them (`environment: test`). */
const CI_ENV_NAMES: Readonly<Record<AbeEnv, RegExp>> = {
  dev: /^(dev|develop|development|local)$/,
  test: /^(test|testing|qa|stage|staging)$/,
  prod: /^(prod|production|live)$/,
};

/**
 * The environments CI's evidence is for: the ones its `environment:` lines name (`ci.yml:60
 * environment: test` is test's alone), else every one.
 */
export const ciEnvsOf = (evidence: string): AbeEnv[] => {
  const said = [...evidence.matchAll(/environment:\s*['"]?([\w-]+)/gi)].map((m) =>
    (m[1] ?? '').toLowerCase(),
  );
  const envs = ABE_ENVS.filter((e) => said.some((w) => CI_ENV_NAMES[e].test(w)));

  return envs.length === 0 ? [...ABE_ENVS] : envs;
};

/**
 * Each environment's blocks from the mapping (load order) and the files' texts (values; never
 * kept or said): a used file's keys to the environments it feeds, a suffixed key to its own,
 * the last file setting a key keeping it; old copies, empty and missing files left out; cloud
 * credential keys left out when an aws profile covers them (`awsCovers`). An environment no file
 * feeds gets CI's keys, names only, when the environments live in CI.
 */
export const abeEnvPrefill = (p: {
  /** Each file placed, in load order: where it goes and the evidence its block's head says. */
  files: readonly { path: string; to: readonly AbeEnv[] | 'not-used' | 'not-sure'; why: string }[];
  texts: Readonly<Record<string, string | undefined>>;
  ci: EnvMappingCi | null;
  awsCovers: boolean;
}): AbeEnvPrefill => {
  const notSure: AbeEnvPrefill['notSure'] = [];
  const left: AbeEnvPrefill['left'] = [];
  const used: {
    file: { path: string; why: string };
    envs: readonly AbeEnv[];
    values: Map<string, string>;
  }[] = [];

  for (const file of p.files) {
    const text = p.texts[file.path];

    if (file.to === 'not-sure') notSure.push({ path: file.path, why: file.why });
    else if (file.to === 'not-used') left.push({ path: file.path, why: file.why });
    else if (isOldEnvCopy(file.path)) left.push({ path: file.path, why: 'an old copy' });
    else if (text === undefined) left.push({ path: file.path, why: 'not there' });
    else if (parseEnvFile(text).size === 0) left.push({ path: file.path, why: 'empty' });
    else used.push({ file, envs: file.to, values: parseEnvFile(text) });
  }
  const credential = new Set<string>(AWS_CREDENTIAL_KEYS);
  const blocksOf = (env: AbeEnv): AbeEnvBlock[] => {
    const parts = used.map((u) => {
      const own = u.envs.includes(env);
      const keys = [...u.values.keys()].filter((k) => {
        const s = suffixEnv(k);

        return s === undefined ? own : s === env;
      });
      const covered = p.awsCovers ? keys.filter((k) => credential.has(k)) : [];

      return { u, own, keys: keys.filter((k) => !covered.includes(k)), covered };
    });
    const last = new Map<string, number>();

    for (const [n, part] of parts.entries()) for (const k of part.keys) last.set(k, n);

    return parts.flatMap(({ u, own, keys, covered }, n): AbeEnvBlock[] => {
      if (keys.length === 0 && covered.length === 0) return [];
      const kept = keys.filter((k) => last.get(k) === n);
      const again = keys.filter((k) => last.get(k) !== n);

      return [
        {
          source: u.file.path,
          head: `${u.file.path}${own ? '' : ` (its _${env.toUpperCase()} keys)`} · ${u.file.why}`,
          lines: [
            ...kept.map((k) => envLine(k, u.values.get(k) ?? '')),
            ...(again.length === 0 ? [] : [`# set again below: ${named(again)}`]),
            ...(covered.length === 0
              ? []
              : [`# left out, the aws profile for ${env} covers them: ${named(covered)}`]),
          ],
        },
      ];
    });
  };
  const ciBlock = (env: AbeEnv, ci: EnvMappingCi): AbeEnvBlock => ({
    source: 'CI',
    head: `CI · ${ci.evidence}`,
    lines: [
      `# ${env} lives in CI; no env file of the repo feeds it.${ci.keys.length === 0 ? '' : ` CI's keys: ${named(ci.keys)}`}`,
    ],
  });
  const ciEnvs = p.ci === null ? [] : ciEnvsOf(p.ci.evidence);
  const withCi = (env: AbeEnv): AbeEnvBlock[] => {
    const own = blocksOf(env);

    return own.length > 0 || p.ci === null || !ciEnvs.includes(env) ? own : [ciBlock(env, p.ci)];
  };
  const blocks = { dev: withCi('dev'), test: withCi('test'), prod: withCi('prod') };

  return { blocks, notSure, left };
};

const START = '# --- from ';
const END = '# --- end ';

/**
 * An Abe env file with its blocks written again: every block there taken out, the person's own
 * lines kept as they are, then each block in order. A key the person set outside the blocks is
 * theirs: a block leaves it out and names it.
 */
export const withAbeBlocks = (current: string, blocks: readonly AbeEnvBlock[]): string => {
  const own: string[] = [];
  const lines = current.split('\n');

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] ?? '';

    if (!line.startsWith(START)) {
      // a block taken out leaves no run of blank lines behind
      if (line.trim() !== '' || (own.at(-1) ?? '').trim() !== '') own.push(line);
      continue;
    }
    // to its end line; one the person took out: to the next block or a blank line
    let end = n + 1;

    while (end < lines.length) {
      const l = lines[end] ?? '';

      if (l.startsWith(END)) break;
      if (l.startsWith(START) || l.trim() === '') {
        end--;
        break;
      }
      end++;
    }
    n = end;
  }
  while (own.length > 0 && (own.at(-1) ?? '').trim() === '') own.pop();
  const yours = parseEnvFile(own.join('\n'));
  const written = blocks.map((b) => {
    const mine = b.lines.flatMap((l) => {
      const key = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l)?.[1];

      return key !== undefined && yours.has(key) ? [key] : [];
    });
    const body = b.lines.filter((l) => {
      const key = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l)?.[1];

      return key === undefined || !yours.has(key);
    });

    return [
      `${START}${b.head}`,
      ...body,
      ...(mine.length === 0 ? [] : [`# yours above: ${named(mine)}`]),
      `${END}${b.source}`,
    ].join('\n');
  });

  return `${[own.join('\n'), ...written].filter((s) => s !== '').join('\n\n')}\n`;
};
