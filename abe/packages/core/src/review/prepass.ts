/**
 * The local pre-pass: the changes nobody reads line by line, found without asking anyone
 * (imports, rename, format, lockfile, generated, snapshot, build output), and the files that copy
 * another file's change.
 */
import { baseName, byBytes, type ChangedFile } from './changes';
import { changedLines, type ChangedLine } from './hunks';

/** A change nobody reads line by line. */
export type Mechanical =
  'imports' | 'rename' | 'format' | 'lockfile' | 'generated' | 'snapshot' | 'build';

/** A file's category: a mechanical change, or a copy of another file's change. */
export type Category = Mechanical | 'copy';

/** The categories in the order their groups list. */
export const CATEGORIES: readonly Category[] = [
  'copy',
  'imports',
  'rename',
  'format',
  'lockfile',
  'generated',
  'snapshot',
  'build',
];

/** How a category's group is named. */
export const CATEGORY_LABEL: Readonly<Record<Category, string>> = {
  copy: 'copy',
  imports: 'imports',
  rename: 'rename',
  format: 'format',
  lockfile: 'lockfile',
  generated: 'generated',
  snapshot: 'snapshot',
  build: 'build output',
};

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
  'Podfile.lock',
  'go.sum',
]);

/** Whether one of a path's folders (not its file name) is among `dirs`. */
const hasDir = (path: string, dirs: readonly string[]): boolean =>
  path
    .split('/')
    .slice(0, -1)
    .some((d) => dirs.includes(d));

/** What a file is by its path alone: a lockfile, a snapshot, generated, build output. */
const byPath = (path: string): Mechanical | undefined => {
  const name = baseName(path);

  if (LOCKFILES.has(name)) return 'lockfile';
  if (hasDir(path, ['__snapshots__']) || name.endsWith('.snap')) return 'snapshot';
  // `x.generated.ts`, `x.gen.ts`
  const parts = name.split('.');
  const genExt = parts.length >= 3 && ['generated', 'gen'].includes(parts.at(-2) ?? '');

  if (
    hasDir(path, ['__generated__', 'generated']) ||
    genExt ||
    name.endsWith('.min.js') ||
    name.endsWith('.min.css') ||
    name.endsWith('.map')
  )
    return 'generated';
  if (hasDir(path, ['dist', 'build', 'cdk.out', 'coverage', '.next', '.turbo'])) return 'build';

  return undefined;
};

/** `s` starts with `word` and then ends, a space or one of `{'"*`. */
const startsWithWord = (s: string, word: string): boolean => {
  if (!s.startsWith(word)) return false;
  const next = s.charAt(word.length);

  return next === '' || /\s/.test(next) || `{'"*`.includes(next);
};

const afterPrefix = (s: string, prefix: string): string | undefined =>
  s.startsWith(prefix) ? s.slice(prefix.length) : undefined;

/** An import or export statement on one line. */
const isImport = (text: string): boolean => {
  const t = text.trimStart();

  // import x from, import { a }, import 'side-effect', import * as, import type
  if (startsWithWord(t, 'import')) return true;
  // export * from, export { a } from, export type { a } from; export { a, b };
  const exported = afterPrefix(t, 'export');

  if (exported !== undefined) {
    const trimmed = exported.trimStart();
    const rest = afterPrefix(trimmed, 'type')?.trimStart() ?? trimmed;

    if (rest.startsWith('*')) return rest.includes('from');
    if (rest.startsWith('{')) {
      const close = rest.indexOf('}');
      const after = close < 0 ? '' : rest.slice(close + 1).trim();

      return after.includes('from') || after === '' || after === ';';
    }
  }
  // the end of an import over several lines
  const closing = afterPrefix(t, '}');

  if (closing !== undefined) {
    const from = afterPrefix(closing.trimStart(), 'from');

    if (from !== undefined) {
      const quote = from.trimStart().charAt(0);

      if (quote === "'" || quote === '"') return true;
    }
  }
  // const { a } = require(
  for (const kw of ['const', 'let', 'var']) {
    const rest = afterPrefix(t, kw);

    if (rest === undefined || !/^\s/.test(rest)) continue;
    const eq = rest.indexOf('=');

    if (eq < 0) continue;
    const names = rest.slice(0, eq);
    const call = rest.slice(eq + 1);

    if (/^[\p{L}\p{N}_${},: \t]*$/u.test(names) && call.trimStart().startsWith('require('))
      return true;
  }

  return false;
};

/** An import or export list over several lines opens here: its brace is not closed on the line. */
const opensBlock = (text: string): boolean => {
  const t = text.trimStart();
  let rest: string;
  const imported = afterPrefix(t, 'import');
  const exported = afterPrefix(t, 'export');

  if (imported !== undefined) {
    const trimmed = imported.trimStart();
    const r = afterPrefix(trimmed, 'type')?.trimStart() ?? trimmed;
    // `import x, {` : a default name before the list
    const comma = r.indexOf(',');
    const name = comma < 0 ? '' : r.slice(0, comma);

    rest =
      comma >= 0 && name !== '' && /^[\p{L}\p{N}_$]*$/u.test(name.trim())
        ? r.slice(comma + 1).trimStart()
        : r;
  } else if (exported !== undefined) {
    const trimmed = exported.trimStart();

    rest = afterPrefix(trimmed, 'type')?.trimStart() ?? trimmed;
  } else return false;

  return rest.startsWith('{') && !rest.includes('}');
};

/**
 * Every line the patch adds or removes is an import or export (a name inside one over several
 * lines too, a hunk heading opening one counts), and there is at least one.
 */
const importsOnly = (patch: string): boolean => {
  let inBlock = false;
  let changed = 0;

  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      const heading = line.split('@@').slice(2).join('@@');

      inBlock = opensBlock(heading.startsWith(' ') ? heading.slice(1) : heading);
      continue;
    }
    const sign = line.charAt(0);
    const text = line.slice(1);
    const counted = (sign === '+' || sign === '-') && text.trim() !== '';
    const opening = !inBlock && opensBlock(text);

    if (counted) {
      if (!inBlock && !opening && !isImport(text)) return false;
      changed += 1;
    }
    if (opening) inBlock = true;
    else if (inBlock && text.includes('}')) inBlock = false;
  }

  return changed > 0;
};

const squeezed = (lines: readonly ChangedLine[], sign: ChangedLine['sign']): string[] =>
  lines
    .filter((l) => l.sign === sign)
    .map((l) => l.text.replace(/\s+/g, ''))
    .filter((t) => t !== '')
    .sort(byBytes);

/** The lines removed and added are the same but for whitespace and blank lines. */
const whitespaceOnly = (lines: readonly ChangedLine[]): boolean => {
  const removed = squeezed(lines, '-');
  const added = squeezed(lines, '+');

  return (
    lines.length > 0 && removed.length === added.length && removed.every((t, i) => t === added[i])
  );
};

/**
 * Why a file needs no reading, if it does not: its path, a rename (git's similarity at least
 * 90 %) whose only edits are whitespace or imports, whitespace, or imports. A binary file has no
 * content category.
 */
const mechanicalOf = (file: ChangedFile): Mechanical | undefined => {
  const kind = byPath(file.path);

  if (kind !== undefined) return kind;
  if (file.binary) return undefined;
  const lines = changedLines(file.patch);
  const quiet = lines.length === 0 || whitespaceOnly(lines) || importsOnly(file.patch);

  if (file.status === 'R' && (file.similarity ?? 100) >= 90 && quiet) return 'rename';
  if (lines.length === 0) return undefined;
  if (whitespaceOnly(lines)) return 'format';

  return importsOnly(file.patch) ? 'imports' : undefined;
};

/** A patch's hunks, each as the lines it changes with whitespace squeezed, blank lines left out. */
const hunkPrints = (patch: string): Set<string> => {
  const hunks: string[] = [];
  let current: string | undefined;

  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      if (current !== undefined) hunks.push(current);
      current = '';
    } else if (current !== undefined) current += `${line}\n`;
  }
  if (current !== undefined) hunks.push(current);
  const prints = new Set<string>();

  for (const hunk of hunks) {
    const print = changedLines(hunk)
      .map((l) => `${l.sign}${l.text.trim().split(/\s+/).filter(Boolean).join(' ')}`)
      .filter((l) => l.length > 1)
      .join('\n');

    if (print !== '') prints.add(print);
  }

  return prints;
};

/**
 * Files whose every hunk an earlier file has too, the same lines changed, as copies of the first
 * such file that is no copy itself; earlier means more hunks, then the bigger change, then the
 * path.
 */
const copiesOf = (files: readonly ChangedFile[]): Record<string, string> => {
  const printed = files
    .filter((f) => !f.binary)
    .map((file) => ({ file, prints: hunkPrints(file.patch) }))
    .filter(({ prints }) => prints.size > 0)
    .sort(
      (a, b) =>
        b.prints.size - a.prints.size ||
        b.file.additions + b.file.deletions - (a.file.additions + a.file.deletions) ||
        byBytes(a.file.path, b.file.path),
    );
  const copies: Record<string, string> = {};

  printed.forEach(({ file, prints }, index) => {
    const original = printed
      .slice(0, index)
      .find(
        (earlier) =>
          !Object.hasOwn(copies, earlier.file.path) &&
          [...prints].every((p) => earlier.prints.has(p)),
      );

    if (original !== undefined) copies[file.path] = original.file.path;
  });

  return copies;
};

/** Each copy pointed at the first original of its chain; a loop stays as it is. */
export const rootedCopies = (copies: Readonly<Record<string, string>>): Record<string, string> => {
  const rootOf = (path: string, seen: readonly string[]): string => {
    const original = Object.hasOwn(copies, path) ? copies[path] : undefined;

    if (original === undefined || seen.includes(original)) return path;

    return rootOf(original, [...seen, path]);
  };
  const out: Record<string, string> = {};

  for (const path of Object.keys(copies).sort(byBytes)) {
    const root = rootOf(path, []);

    if (root !== path) out[path] = root;
  }

  return out;
};

/** The local pre-pass: each file's mechanical category, and copies among the rest. */
export type Prepass = {
  mechanical: Record<string, Mechanical>;
  /** A copy's path → the file it repeats. */
  copies: Record<string, string>;
};

export const prepass = (files: readonly ChangedFile[]): Prepass => {
  const mechanical: Record<string, Mechanical> = {};

  for (const file of files) {
    const kind = mechanicalOf(file);

    if (kind !== undefined) mechanical[file.path] = kind;
  }

  return {
    mechanical,
    copies: copiesOf(files.filter((f) => !Object.hasOwn(mechanical, f.path))),
  };
};
