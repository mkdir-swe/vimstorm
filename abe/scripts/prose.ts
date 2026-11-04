/**
 * The prose check (ADR 0024). Code comments, test names and docs never cite an issue, since git
 * and the tracker hold that. Comments and docs also carry no em dash and none of unslop's words. A
 * folder still on an unswept list is skipped, and a listed folder with nothing left to fix fails
 * until it comes off. `bun scripts/prose.ts <path>...` prints every finding under those paths, listed or not.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { FOLDER_TABLES, type FolderTables, PACKAGES } from '../packages/testing/src/graph';

/** The repository this workspace sits in. */
export const REPO = resolve(import.meta.dir, '..', '..');

/** Where the check reads, from the repository's root. */
export const ROOTS = [
  'AGENTS.md',
  'GLOSSARY.md',
  'README.md',
  'abe',
  'app/README.md',
  'app/src',
  'app/tests',
  'docs',
  'nvim',
  'tests',
] as const;

/** Text outside the packages' `src` not swept yet, by path from the repository's root. */
export const UNSWEPT: readonly string[] = [
  'abe/images',
  'abe/packages/core/skills',
  'abe/scripts',
  'docs',
  'nvim',
  'tests',
];

const READ = /\.(tsx?|rs|lua|md)$/;

const SKIPPED = new Set([
  '.git',
  '.scratch',
  'contract',
  'dist',
  'fixtures',
  'node_modules',
  'schema',
  'target',
]);

/** A package's `contract` folder under `src` is code; every other `contract` holds trees. */
const skipped = (parent: string, name: string) =>
  SKIPPED.has(name) && !(name === 'contract' && parent.endsWith('/src'));

export type Kind = 'issue' | 'dash' | 'word';

export type Finding = { line: number; kind: Kind; text: string };

/** A piece of a file's text the check reads: a comment, a test's name or a doc's prose. */
type Piece = { at: number; text: string; prose: boolean };

const ISSUE = /(?<![\w#&/-])#\d{1,4}\b|\bvimstorm#\d+\b|\/(?:issues|pull)\/\d+\b/g;

const DASH = /—/g;

/** Unslop's words, as whole words, any case. */
const WORDS = new RegExp(
  `\\b(?:${[
    'additionally',
    'crucial(?:ly)?',
    'delve[sd]?',
    'delving',
    'enduring',
    'enhance[sd]?',
    'enhancing',
    'foster(?:s|ed|ing)?',
    'garner(?:s|ed)?',
    'interplay',
    'intricate',
    'pivotal',
    'showcas(?:e[sd]?|ing)',
    'tapestry',
    'testament',
    'vibrant',
    'nestled',
    'breathtaking',
    'groundbreaking',
    'renowned',
    'stunning',
    'serves as',
    'stands as',
    'boasts?',
    'utili[sz](?:e[sd]?|ing)',
    'leverag(?:e[sd]?|ing)',
    'facilitat(?:e[sd]?|ing)',
    'numerous',
    'seamless(?:ly)?',
    'indelible',
    'deeply rooted',
    'setting the stage',
  ].join('|')})\\b`,
  'gi',
);

const lineAt = (text: string, at: number) => text.slice(0, at).split('\n').length;

const TEST_CALLS = new Set(['test', 'it', 'describe']);

/** The name a test, `it` or `describe` call gives, with any `.each(…)`, `.skip` or `.if(…)`. */
const testName = (call: ts.CallExpression): ts.Node | undefined => {
  let callee: ts.Expression = call.expression;

  while (ts.isCallExpression(callee) || ts.isPropertyAccessExpression(callee))
    callee = callee.expression;
  const name = call.arguments[0];

  return ts.isIdentifier(callee) &&
    TEST_CALLS.has(callee.text) &&
    name !== undefined &&
    (ts.isStringLiteralLike(name) || ts.isTemplateExpression(name))
    ? name
    : undefined;
};

const typescript = (path: string, text: string): Piece[] => {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const seen = new Set<number>();
  const pieces: Piece[] = [];
  const comments = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const r of ranges ?? []) {
      if (seen.has(r.pos)) continue;
      seen.add(r.pos);
      pieces.push({ at: r.pos, text: text.slice(r.pos, r.end), prose: true });
    }
  };
  const visit = (node: ts.Node) => {
    comments(ts.getLeadingCommentRanges(text, node.getFullStart()));
    comments(ts.getTrailingCommentRanges(text, node.getEnd()));
    if (ts.isCallExpression(node)) {
      const name = testName(node);

      if (name !== undefined)
        pieces.push({ at: name.getStart(source), text: name.getText(source), prose: false });
    }
    for (const child of node.getChildren(source)) visit(child);
  };

  visit(source);

  return pieces;
};

/** Comments of a C-like language with `"…"` strings; Rust's raw strings and chars too. */
const rust = (text: string): Piece[] => {
  const pieces: Piece[] = [];
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    const raw = /^r(#*)"/.exec(text.slice(i, i + 12));

    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;

      pieces.push({ at: i, text: text.slice(i, stop), prose: true });
      i = stop;
    } else if (text.startsWith('/*', i)) {
      let depth = 0;
      let j = i;

      while (j < text.length) {
        if (text.startsWith('/*', j)) {
          depth += 1;
          j += 2;
        } else if (text.startsWith('*/', j)) {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
        } else j += 1;
      }
      pieces.push({ at: i, text: text.slice(i, j), prose: true });
      i = j;
    } else if (raw !== null && !/\w/.test(text[i - 1] ?? '')) {
      const close = `"${raw[1] ?? ''}`;
      const end = text.indexOf(close, i + raw[0].length);

      i = end === -1 ? text.length : end + close.length;
    } else if (c === '"') {
      let j = i + 1;

      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
    } else if (c === "'") {
      if (text[i + 1] === '\\') i = text.indexOf("'", i + 2) + 1 || text.length;
      else i += text[i + 2] === "'" ? 3 : 1;
    } else i += 1;
  }

  return pieces;
};

/** Lua's comments: `--` to the line's end, `--[[ … ]]`; strings `"…"`, `'…'` and `[[ … ]]`. */
const lua = (text: string): Piece[] => {
  const pieces: Piece[] = [];
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    const long = /^\[(=*)\[/.exec(text.slice(i, i + 8));

    if (text.startsWith('--', i)) {
      const block = /^--\[(=*)\[/.exec(text.slice(i, i + 10));
      const close = block === null ? '\n' : `]${block[1] ?? ''}]`;
      const end = text.indexOf(close, i + 2);
      const stop = end === -1 ? text.length : end + (block === null ? 0 : close.length);

      pieces.push({ at: i, text: text.slice(i, stop), prose: true });
      i = stop;
    } else if (long !== null) {
      const close = `]${long[1] ?? ''}]`;
      const end = text.indexOf(close, i);

      i = end === -1 ? text.length : end + close.length;
    } else if (c === '"' || c === "'") {
      let j = i + 1;

      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
    } else i += 1;
  }

  return pieces;
};

const blank = (s: string) => s.replace(/[^\n]/g, ' ');

/** Inline code quotes what the code says, so the check reads around it; lines still count. */
const withoutCode = (text: string) => text.replace(/(`+)[^`\n]+?\1/g, blank);

/** A doc's prose: everything outside fenced and inline code. */
const markdown = (text: string): Piece[] => [
  { at: 0, text: text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, blank), prose: true },
];

const READERS: Readonly<Partial<Record<string, (path: string, text: string) => Piece[]>>> = {
  '.ts': typescript,
  '.tsx': typescript,
  '.rs': (_path, text) => rust(text),
  '.lua': (_path, text) => lua(text),
  '.md': (_path, text) => markdown(text),
};

/** What one file breaks, by its extension; a file of another kind breaks nothing. */
export const findings = (path: string, text: string): Finding[] => {
  const read = READERS[extname(path)];
  const pieces = read === undefined ? [] : read(path, text);
  const found: Finding[] = [];
  const scan = (piece: Piece, re: RegExp, kind: Kind) => {
    for (const m of piece.text.matchAll(re))
      found.push({ line: lineAt(text, piece.at + m.index), kind, text: m[0] });
  };

  for (const read of pieces) {
    const piece = read.prose ? { ...read, text: withoutCode(read.text) } : read;

    scan(piece, ISSUE, 'issue');
    if (!piece.prose) continue;
    scan(piece, DASH, 'dash');
    scan(piece, WORDS, 'word');
  }

  return found.sort((a, b) => a.line - b.line);
};

/** Every file the check reads under `paths`, from the repository's root. */
export const filesUnder = (repo: string, paths: readonly string[]): string[] =>
  paths.flatMap((path) => {
    const full = join(repo, path);

    if (!statSync(full, { throwIfNoEntry: false })?.isDirectory())
      return READ.test(path) ? [path] : [];

    return readdirSync(full, { withFileTypes: true })
      .filter((entry) => !skipped(path, entry.name) && !entry.isSymbolicLink())
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => filesUnder(repo, [join(path, entry.name)]));
  });

/** The unswept place a file sits in: its package folder's name, or the path on `outside`. */
const placeOf = (
  file: string,
  tables: FolderTables,
  outside: readonly string[],
): string | undefined => {
  const parts = file.split('/');
  const pkg = PACKAGES.find((p) => p === parts[2]);

  if (parts[0] === 'abe' && parts[1] === 'packages' && pkg !== undefined && parts[3] === 'src') {
    const folder = parts.length === 5 ? '.' : (parts[4] ?? '');

    return tables[pkg].unswept.prose.includes(folder) ? `${pkg}:${folder}` : undefined;
  }

  return outside.find((p) => file === p || file.startsWith(`${p}/`));
};

const placeName = (place: string) => {
  const [pkg, folder] = place.split(':');

  return folder === undefined ? `${place} on UNSWEPT` : `${pkg}'s ${folder} on unswept.prose`;
};

export type ProseCheck = { broken: string[]; stale: string[] };

/** What `files` (paths from `repo`) break outside the unswept places, and the places now clean. */
export const checkProse = (
  repo: string,
  files: readonly string[],
  tables: FolderTables = FOLDER_TABLES,
  outside: readonly string[] = UNSWEPT,
): ProseCheck => {
  const broken: string[] = [];
  const dirty = new Set<string>();

  for (const file of files) {
    const found = findings(file, readFileSync(join(repo, file), 'utf8'));
    const place = placeOf(file, tables, outside);

    if (found.length === 0) continue;
    if (place !== undefined) dirty.add(place);
    else broken.push(...found.map((f) => `${file}:${f.line}: ${f.kind} ${f.text}`));
  }
  const listed = [
    ...PACKAGES.flatMap((pkg) => tables[pkg].unswept.prose.map((f) => `${pkg}:${f}`)),
    ...outside,
  ];

  return {
    broken,
    stale: listed
      .filter((p) => !dirty.has(p))
      .map((p) => `${placeName(p)} has nothing left to fix: take it off`),
  };
};

if (import.meta.main) {
  const paths = process.argv.slice(2).map((p) => relative(REPO, resolve(p)));
  let count = 0;

  for (const file of filesUnder(REPO, paths.length === 0 ? ROOTS : paths)) {
    for (const f of findings(file, readFileSync(join(REPO, file), 'utf8'))) {
      console.log(`${file}:${f.line}: ${f.kind} ${f.text}`);
      count += 1;
    }
  }
  process.exit(count === 0 ? 0 : 1);
}
