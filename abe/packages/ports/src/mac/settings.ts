/**
 * The settings files on disk (ADR 0030): where they are, read as YAML, written whole. IO only;
 * what the entries mean is `core`'s.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  DEFAULT_HOOKS,
  type FoundFiles,
  individualFile,
  localFile,
  REPO_PATH,
  type RepoHooks,
  repoFile,
  repoHooksOfDoc,
} from '@abe/core';
import { Document, isMap, isNode, isScalar, type Pair, parseDocument, YAMLMap } from 'yaml';
import { type Env } from './locations';
import { runOwn } from './process';

export type SettingsPlaces = {
  /** Yours on this Mac: `$ABE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/abe`, else `~/.config/abe`. */
  configDir: string;
  home: string;
};

const set = (value: string | undefined) =>
  value === undefined || value === '' ? undefined : value;

export const settingsPlaces = (env: Env, home: string): SettingsPlaces => ({
  configDir:
    set(env.ABE_CONFIG_DIR) ?? join(set(env.XDG_CONFIG_HOME) ?? join(home, '.config'), 'abe'),
  home,
});

export type YamlRead = { doc: unknown } | { error: string };

/** A YAML text's document (`undefined` for an empty one), or why it does not parse. */
export const parseYaml = (text: string): YamlRead => {
  const parsed = parseDocument(text);
  const [first] = parsed.errors;

  if (first !== undefined) return { error: `not YAML: ${first.message}` };

  return { doc: parsed.toJS() ?? undefined };
};

/** A file's text, `undefined` when there is none. */
export const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/** A layer file's document: a missing file reads as `undefined`. */
export const readYamlFile = (path: string): YamlRead => {
  const text = readText(path);

  return text === undefined ? { doc: undefined } : parseYaml(text);
};

const entriesOf = (v: unknown): [string, unknown][] | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.entries(v) : undefined;

/** Changes `yaml` at `path` from `before` to `after`, node by node, so untouched lines and comments stay. */
const sync = (yaml: Document, path: string[], before: unknown, after: unknown) => {
  const was = entriesOf(before);
  const will = entriesOf(after);

  if (was !== undefined && will !== undefined) {
    const old = new Map(was);
    const kept = new Map(will);

    for (const [k] of was) if (!kept.has(k)) yaml.deleteIn([...path, k]);
    for (const [k, v] of will) sync(yaml, [...path, k], old.get(k), v);
  } else if (JSON.stringify(before) !== JSON.stringify(after)) yaml.setIn(path, after);
};

/**
 * Writes `doc` as the file, by a temporary file renamed over, making its folder. An existing
 * file is edited where it differs, so its comments and layout stay.
 */
export const writeYamlFile = (path: string, doc: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;

  writeFileSync(temp, yamlText(readText(path), doc));
  renameSync(temp, path);
};

/** Writes your Layer's `keys.json` (#129: a key → its action) as two-space JSON, renamed over. */
export const writeKeysFile = (path: string, doc: Readonly<Record<string, unknown>>): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;

  writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(temp, path);
};

/**
 * How a write prints what it changes: `[a, b]` as written, never `[ a, b ]`, and a null as
 * `key: null`, never the explicit `? key` a map of nulls alone prints as.
 */
const PRINT = { flowCollectionPadding: false, simpleKeys: true } as const;

/** One stretch of a file's text replaced: `[from, to)` by `text`. */
type Splice = { from: number; to: number; text: string };

const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1;

/** Just past the line `at` ends inside (`at` itself when it starts a line). */
const lineEnd = (text: string, at: number) => {
  if (at > 0 && text[at - 1] === '\n') return at;
  const next = text.indexOf('\n', at);

  return next === -1 ? text.length : next + 1;
};

/** An entry's key as `toJS` names it; a key `sync` added is a bare string, not a node. */
const keyOf = (pair: Pair): string | undefined => {
  const key = isScalar(pair.key) ? pair.key.value : pair.key;

  return typeof key === 'string' || typeof key === 'number' || typeof key === 'boolean'
    ? String(key)
    : undefined;
};

/** The whole lines a block map's entry is written on: its key's line to its value's last. */
const spanOf = (text: string, pair: Pair): [number, number] | undefined => {
  if (!isScalar(pair.key) || !pair.key.range) return undefined;
  const end = isNode(pair.value) ? pair.value.range?.[2] : pair.key.range[2];

  return end === undefined ? undefined : [lineStart(text, pair.key.range[0]), lineEnd(text, end)];
};

/** An entry printed on its own at `indent`, without the comment above it (that line stays). */
const entryText = (pair: Pair, indent: string): string => {
  const one = pair.clone();

  if (isScalar(one.key)) {
    one.key.commentBefore = null;
    one.key.spaceBefore = false;
  }
  const map = new YAMLMap();

  map.items.push(one);
  const printed = new Document(map).toString(PRINT);

  return printed
    .split('\n')
    .map((line) => (line === '' ? line : `${indent}${line}`))
    .join('\n');
};

/**
 * The splices that turn block map `was` (as `text` has it, reading as `before`) into `now` (the
 * same map with `sync` applied, reading as `after`): an untouched entry keeps its lines byte for
 * byte, a changed block map is gone into, any other change prints that entry alone, a new one
 * goes after the last. `undefined` when the map is not one this can splice (#176).
 */
const spliceMap = (
  text: string,
  was: YAMLMap,
  now: YAMLMap,
  before: unknown,
  after: unknown,
): Splice[] | undefined => {
  const old = new Map(entriesOf(before));
  const will = new Map(entriesOf(after));
  const [first] = was.items;
  const at = first === undefined || !isScalar(first.key) ? undefined : first.key.range?.[0];

  // a map emptied must still read as `{}`, which only its parent can print
  if (was.flow === true || at === undefined || will.size === 0) return undefined;
  const indent = text.slice(lineStart(text, at), at);

  if (indent.trim() !== '') return undefined;
  const nowPair = (k: string) => now.items.find((p) => keyOf(p) === k);
  const out: Splice[] = [];
  let last = 0;

  for (const pair of was.items) {
    const k = keyOf(pair);
    const span = spanOf(text, pair);

    if (k === undefined || span === undefined) return undefined;
    const [from, to] = span;

    last = Math.max(last, to);
    if (!will.has(k)) {
      out.push({ from, to, text: '' });
      continue;
    }
    const b = old.get(k);
    const a = will.get(k);

    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    const next = nowPair(k);

    if (next === undefined) return undefined;
    const inner =
      isMap(pair.value) && isMap(next.value)
        ? spliceMap(text, pair.value, next.value, b, a)
        : undefined;

    out.push(...(inner ?? [{ from, to, text: entryText(next, indent) }]));
  }
  const added = [...will.keys()].filter((k) => !old.has(k));
  const lines: string[] = [];

  for (const k of added) {
    const next = nowPair(k);

    if (next === undefined) return undefined;
    lines.push(entryText(next, indent));
  }
  if (lines.length > 0) out.push({ from: last, to: last, text: lines.join('') });

  return out;
};

/**
 * `doc` as YAML text: `text` (a file as it is, `undefined` for none) edited where it differs, so
 * its comments and layout stay, or written anew. Lines a write does not change come back byte for
 * byte, flow maps and lists as written (#176); a top-level map the splicer can't take is printed
 * whole by the library, after the same edits.
 */
export const yamlText = (text: string | undefined, doc: unknown): string => {
  const yaml = parseDocument(text ?? '');
  const was: unknown = yaml.toJS();
  const edit =
    text !== undefined &&
    yaml.errors.length === 0 &&
    entriesOf(was) !== undefined &&
    entriesOf(doc) !== undefined;

  // a file of comments alone (a header) keeps them, the entries after
  const header =
    text !== undefined && yaml.errors.length === 0 && (was === null || was === undefined);

  if (!edit && header && entriesOf(doc) !== undefined)
    return `${text.endsWith('\n') || text === '' ? text : `${text}\n`}${new Document(doc).toString(PRINT)}`;
  if (!edit) return new Document(doc).toString(PRINT);
  const original = yaml.contents;
  const synced = yaml.clone();
  // every printed entry ends its line, so the lines it follows must too (offsets stay the same)
  const whole = text.endsWith('\n') ? text : `${text}\n`;

  sync(synced, [], was, doc);
  const splices =
    isMap(original) && isMap(synced.contents)
      ? spliceMap(whole, original, synced.contents, was, doc)
      : undefined;

  if (splices === undefined) return synced.toString(PRINT);
  if (splices.length === 0) return text;

  return [...splices]
    .sort((x, y) => y.from - x.from)
    .reduce((t, s) => `${t.slice(0, s.from)}${s.text}${t.slice(s.to)}`, whole);
};

/** The git checkout holding `cwd` (its top folder), found by walking up to a `.git`. */
export const repoRoot = (cwd: string): string | undefined => {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
};

/**
 * The main checkout holding `dir`: its top folder, or for a linked worktree (a card's) the
 * checkout it was added from; undefined outside a checkout.
 */
export const mainCheckout = (dir: string): string | undefined => {
  const top = repoRoot(dir);

  if (top === undefined) return undefined;
  const dotGit = join(top, '.git');
  let real = top;

  try {
    if (statSync(dotGit).isFile()) {
      const [, gitdir] = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8')) ?? [];
      const at = gitdir?.trim().lastIndexOf('/.git/worktrees/') ?? -1;

      if (gitdir !== undefined && at !== -1) {
        const abs = isAbsolute(gitdir.trim()) ? gitdir.trim() : resolve(top, gitdir.trim());

        real = abs.slice(0, abs.lastIndexOf('/.git/worktrees/'));
      }
    }
    real = realpathSync(real);
  } catch {
    // a checkout that vanished meanwhile: as found
  }

  return real;
};

/**
 * The repo's hook points as its main checkout has `abe.yaml` committed (`HEAD:abe.yaml`, ADR
 * 0035): what an agent's `abe run` may run, on this Mac and handed to a box, never a working copy
 * an agent may write. No commit, no file, or no YAML there: today's places.
 */
export const committedHooks = async (checkout: string): Promise<RepoHooks> => {
  const main = mainCheckout(checkout) ?? checkout;
  const shown = await runOwn([
    'git',
    '-C',
    main,
    '-c',
    'core.fsmonitor=false',
    'show',
    `HEAD:${REPO_PATH}`,
  ]);

  if (shown.exit !== 0) return DEFAULT_HOOKS;
  const read = parseYaml(shown.stdout);

  return 'doc' in read ? repoHooksOfDoc(read.doc) : DEFAULT_HOOKS;
};

export const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The settings files a folder holds, for `abe settings check`. */
export const findLayerFiles = (dir: string): FoundFiles => {
  const present = (path: string) => (existsSync(path) ? path : undefined);

  return {
    top: present(individualFile(dir)),
    repo: present(repoFile(dir)),
    local: present(localFile(dir)),
  };
};
