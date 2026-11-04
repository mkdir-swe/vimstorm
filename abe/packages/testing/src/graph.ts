/**
 * The workspace's dependency graph, read from every package's imports. Packages import only the
 * edges the platform spec allows, and inside a package a folder imports another folder only
 * through its interface (ADR 0024, the folder tables in `packages/<package>/folders.ts`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import coreFolders from '../../core/folders';
import hooksFolders from '../../hooks/folders';
import portsFolders from '../../ports/folders';
import serveFolders from '../../serve/folders';
import uiFolders from '../../ui/folders';
import testingFolders from '../folders';

export const PACKAGES = ['core', 'ports', 'serve', 'ui', 'hooks', 'testing'] as const;
export type Package = (typeof PACKAGES)[number];

type Rule = {
  /** Workspace packages it may import values from. */
  packages: readonly Package[];
  /** Workspace packages it may import only types from (`import type`). */
  types: readonly Package[];
  /** Single modules of those `types` packages it may import values from, by their export path. */
  modules?: readonly string[];
  /** npm packages it may import; `'any'` for the IO packages. */
  external: readonly string[] | 'any';
  /** Node / Bun built-ins (`node:fs`, `bun`). */
  builtins: boolean;
};

/** What each package may import, as the platform spec's "The workspace" says. */
export const RULES: Readonly<Record<Package, Rule>> = {
  core: { packages: [], types: [], external: ['zod'], builtins: false },
  ports: { packages: ['core'], types: [], external: 'any', builtins: true },
  // `abe hook` ships in the one binary: its entry starts the hook before anything else loads.
  serve: { packages: ['core', 'ports', 'hooks', 'ui'], types: [], external: 'any', builtins: true },
  // Screens check their trees with zod, and take a few of core's pure modules as values: the
  // words for steps, boxes, launches and cards, the clock's wording, the repo a row was read in,
  // and whether a session waits on you. Each imports only types and zod itself.
  ui: {
    packages: [],
    types: ['core'],
    modules: [
      '@abe/core/steps',
      '@abe/core/box-text',
      '@abe/core/when',
      '@abe/core/here',
      '@abe/core/launch',
      '@abe/core/pipelines',
      '@abe/core/prototype-tag',
      '@abe/core/linked-keys',
      '@abe/core/model-name',
      '@abe/core/waits-on',
      '@abe/core/card-images',
      '@abe/core/draft-fields',
      '@abe/core/launch-words',
      '@abe/core/grill',
      '@abe/core/local-names',
      '@abe/core/box-ports',
      '@abe/core/workflow-pick',
      '@abe/core/run-flow',
    ],
    external: ['zod'],
    builtins: false,
  },
  // A PermissionRequest resolves a file tool's paths inside the container, so core's permission
  // module (pure, zod only) loads for that event alone. A local session's source writes are
  // refused by core's source-tools (no imports at all), read for every PreToolUse.
  hooks: {
    packages: [],
    types: ['core'],
    modules: ['@abe/core/permission', '@abe/core/source-tools'],
    external: [],
    builtins: true,
  },
  testing: { packages: PACKAGES, types: [], external: 'any', builtins: true },
};

export type SourceFile = { path: string; text: string };

type Import = { specifier: string; typeOnly: boolean; line: number };

const BUILTINS = new Set(builtinModules);

const isBuiltin = (s: string) =>
  s.startsWith('node:') ||
  s === 'bun' ||
  s.startsWith('bun:') ||
  BUILTINS.has(s.split('/')[0] ?? '');

const literal = (node: ts.Node | undefined) =>
  node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;

const parsed = new WeakMap<SourceFile, Import[]>();

/** Every import, re-export, `import()` and `require()` of a file, and whether it is types only. */
export const importsOf = (file: SourceFile): Import[] => {
  const known = parsed.get(file);

  if (known !== undefined) return known;
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
  const found: Import[] = [];
  const add = (node: ts.Node, specifier: string | undefined, typeOnly: boolean) => {
    if (specifier === undefined) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));

    found.push({ specifier, typeOnly, line: line + 1 });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const allTypes =
        clause !== undefined &&
        clause.name === undefined &&
        named !== undefined &&
        ts.isNamedImports(named) &&
        named.elements.length > 0 &&
        named.elements.every((e) => e.isTypeOnly);

      const typeClause = clause?.phaseModifier === ts.SyntaxKind.TypeKeyword;

      add(node, literal(node.moduleSpecifier), typeClause || allTypes);
    } else if (ts.isExportDeclaration(node)) {
      add(node, literal(node.moduleSpecifier), node.isTypeOnly);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node, literal(node.moduleReference.expression), node.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      add(
        node,
        literal(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined),
        true,
      );
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(callee) && callee.text === 'require';

      if (dynamic || required) add(node, literal(node.arguments[0]), false);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  parsed.set(file, found);

  return found;
};

const packageOf = (root: string, path: string): Package | undefined => {
  const [top, name] = relative(root, path).split(sep);

  return top === 'packages' ? PACKAGES.find((p) => p === name) : undefined;
};

const target = (
  root: string,
  from: string,
  specifier: string,
): { pkg?: Package; external?: string; builtin?: true; outside?: true } => {
  if (specifier.startsWith('.')) {
    const pkg = packageOf(root, resolve(dirname(from), specifier));

    return pkg === undefined ? { outside: true } : { pkg };
  }
  if (isBuiltin(specifier)) return { builtin: true };
  const [scope = '', name = ''] = specifier.split('/');

  if (scope === '@abe') {
    const pkg = PACKAGES.find((p) => p === name);

    return pkg === undefined ? { external: specifier } : { pkg };
  }

  return { external: scope.startsWith('@') ? `${scope}/${name}` : scope };
};

/**
 * One folder of a package's `src`: a module. Other folders, and other packages, import only its
 * interface; every other file in it is private.
 */
export type Folder = {
  /** The other folders of its package it may import, each through its interface. */
  imports: readonly string[];
  /** The one file others import, relative to the folder; `index.ts` when left out. */
  interface?: string;
  /** Private files its own tests may import too, for a seam the interface doesn't show. */
  seams?: readonly string[];
};

/** A package's folders, in `packages/<package>/folders.ts`. */
export type FolderTable = {
  /** By name under `src`; `.` is the files directly in `src`, with `index.ts` as its interface. */
  folders: Readonly<Record<string, Folder>>;
  /**
   * Folders not swept yet. The folder rules skip the imports of a folder in `imports`, and the
   * prose check skips the text of one in `prose`. The lists only shrink: a folder that breaks no
   * rule fails until it comes off.
   */
  unswept: { imports: readonly string[]; prose: readonly string[] };
};

export type FolderTables = Readonly<Record<Package, FolderTable>>;

export const FOLDER_TABLES: FolderTables = {
  core: coreFolders,
  ports: portsFolders,
  serve: serveFolders,
  ui: uiFolders,
  hooks: hooksFolders,
  testing: testingFolders,
};

const ROOT = '.';

const isTest = (path: string) => /\.test\.tsx?$/.test(path);

/** A file's place: its package, and its folder and path inside that folder when it is in `src`. */
type Place = { pkg: Package; folder?: string; rest?: string };

/** With `tables`, a path that names a folder of its package is that folder's `index`. */
const placeOf = (root: string, path: string, tables?: FolderTables): Place | undefined => {
  const pkg = packageOf(root, path);

  if (pkg === undefined) return undefined;
  const parts = relative(join(root, 'packages', pkg, 'src'), path).split(sep);

  if (parts[0] === '..') return { pkg };
  const top = parts[0] ?? '';

  if (parts.length > 1) return { pkg, folder: top, rest: parts.slice(1).join('/') };
  if (tables !== undefined && top !== ROOT && Object.hasOwn(tables[pkg].folders, top))
    return { pkg, folder: top, rest: '' };

  return { pkg, folder: ROOT, rest: top };
};

const PackageJson = z.object({ exports: z.record(z.string(), z.string()) });

const exportsOf = (root: string, pkg: Package): Readonly<Record<string, string>> =>
  PackageJson.parse(JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8')))
    .exports;

/** The path an import names, or the package whose entry points lack it; else an npm package. */
const fileOf = (
  root: string,
  from: string,
  specifier: string,
  exports: (pkg: Package) => Readonly<Record<string, string>>,
): { path: string } | { notExported: Package } | undefined => {
  if (specifier.startsWith('.')) return { path: resolve(dirname(from), specifier) };
  const [scope, name = '', ...sub] = specifier.split('/');
  const pkg = PACKAGES.find((p) => p === name);

  if (scope !== '@abe' || pkg === undefined) return undefined;
  const entry = exports(pkg)[sub.length === 0 ? '.' : `./${sub.join('/')}`];

  return entry === undefined
    ? { notExported: pkg }
    : { path: resolve(root, 'packages', pkg, entry) };
};

const stem = (file: string) => file.replace(/\.(tsx?|js)$/, '');

const isInterface = (folder: Folder | undefined, rest: string) => {
  const own = stem(folder?.interface ?? 'index.ts');

  return stem(rest) === own || (own === 'index' && rest === '');
};

/** Each cycle in a table's declared imports, as `a → b → a`. */
const cyclesOf = (table: FolderTable): string[] => {
  const found = new Set<string>();
  const walk = (name: string, path: readonly string[]) => {
    const at = path.indexOf(name);

    if (at !== -1) {
      const loop = path.slice(at);
      const first = loop.indexOf([...loop].sort()[0] ?? name);

      found.add([...loop.slice(first), ...loop.slice(0, first), loop[first]].join(' → '));

      return;
    }
    for (const next of table.folders[name]?.imports ?? []) walk(next, [...path, name]);
  };

  for (const name of Object.keys(table.folders)) walk(name, []);

  return [...found];
};

/** What is wrong with the tables themselves: unknown names, and cycles. */
const tableErrors = (tables: FolderTables): string[] =>
  PACKAGES.flatMap((pkg) => {
    const table = tables[pkg];
    const known = (name: string) => Object.hasOwn(table.folders, name);
    const unknown = (list: string, names: readonly string[]) =>
      names.filter((n) => !known(n)).map((n) => `${pkg}'s ${list} names ${n}, not a folder`);

    return [
      ...Object.entries(table.folders).flatMap(([name, f]) =>
        unknown(`folder ${name} imports`, f.imports),
      ),
      ...unknown('unswept.imports', table.unswept.imports),
      ...unknown('unswept.prose', table.unswept.prose),
      ...cyclesOf(table).map((c) => `${pkg}'s folder table has a cycle: ${c}`),
    ];
  });

type FolderBreak = { pkg: Package; folder: string; text: string };

/** Every import past a folder's interface, and every file in a folder its table lacks. */
const folderBreaks = (
  root: string,
  files: readonly SourceFile[],
  tables: FolderTables,
): FolderBreak[] => {
  const found: FolderBreak[] = [];
  const read = new Map(PACKAGES.map((pkg) => [pkg, exportsOf(root, pkg)]));
  const exports = (pkg: Package) => read.get(pkg) ?? {};

  for (const file of files) {
    const own = placeOf(root, file.path);

    if (own?.folder === undefined) continue;
    const { pkg, folder } = own;
    const row = tables[pkg].folders[folder];
    const where = relative(root, file.path);
    const add = (text: string) => found.push({ pkg, folder, text });

    if (row === undefined) {
      add(`${where}: ${folder} is not a folder in ${pkg}'s folder table`);
      continue;
    }
    for (const imp of importsOf(file)) {
      const named = fileOf(root, file.path, imp.specifier, exports);

      if (named === undefined) continue;
      const at = `${where}:${imp.line} imports ${imp.specifier}`;

      if ('notExported' in named) {
        add(`${at}: not an entry point of ${named.notExported}`);
        continue;
      }
      const to = placeOf(root, named.path, tables);

      if (to?.folder === undefined || to.rest === undefined) continue;
      const target = tables[to.pkg].folders[to.folder];
      const iface = `${to.folder === ROOT ? '' : `${to.folder}/`}${target?.interface ?? 'index.ts'}`;

      if (to.pkg !== pkg) {
        // a single module the package's rule lets it import is an interface of its own
        if (!isInterface(target, to.rest) && !(RULES[pkg].modules ?? []).includes(imp.specifier))
          add(`${at}: past the interface of ${to.pkg}'s ${to.folder} (${iface})`);
      } else if (to.folder === folder) {
        const seam = (row.seams ?? []).some((s) => stem(s) === stem(to.rest ?? ''));

        if (isTest(file.path) && !isInterface(row, to.rest) && !seam)
          add(`${at}: a test imports its folder's interface (${iface}) or a seam the table names`);
      } else if (target === undefined) {
        add(`${at}: ${to.folder} is not a folder in ${pkg}'s folder table`);
      } else if (!row.imports.includes(to.folder)) {
        add(`${at}: ${folder} may not import ${to.folder}`);
      } else if (!isInterface(target, to.rest)) {
        add(`${at}: past the interface of ${to.folder} (${iface})`);
      }
    }
  }

  return found;
};

/** What `files` (paths absolute, under `root`) break: `RULES`, then the folder tables. */
export const checkGraph = (
  root: string,
  files: readonly SourceFile[],
  tables: FolderTables = FOLDER_TABLES,
): string[] => {
  const broken: string[] = [];

  for (const file of files) {
    const own = packageOf(root, file.path);

    if (own === undefined || isTest(file.path)) continue;
    const rule = RULES[own];
    const where = relative(root, file.path);

    for (const imp of importsOf(file)) {
      const to = target(root, file.path, imp.specifier);
      const at = `${where}:${imp.line} imports ${imp.specifier}`;

      if (to.outside === true) broken.push(`${at}: outside the workspace's packages`);
      else if (to.builtin === true) {
        if (!rule.builtins) broken.push(`${at}: ${own} may not use Node or Bun built-ins`);
      } else if (to.external !== undefined) {
        if (rule.external !== 'any' && !rule.external.includes(to.external))
          broken.push(`${at}: ${own} may not import ${to.external}`);
      } else if (to.pkg !== undefined && to.pkg !== own) {
        const values =
          rule.packages.includes(to.pkg) || (rule.modules ?? []).includes(imp.specifier);
        const types = rule.types.includes(to.pkg);

        if (!values && !(types && imp.typeOnly))
          broken.push(
            types
              ? `${at}: ${own} may import only types from ${to.pkg} (import type)`
              : `${at}: ${own} may not import ${to.pkg}`,
          );
      }
    }
  }

  const unswept = (b: FolderBreak) => tables[b.pkg].unswept.imports.includes(b.folder);

  return [
    ...broken,
    ...tableErrors(tables),
    ...folderBreaks(root, files, tables)
      .filter((b) => !unswept(b))
      .map((b) => b.text),
  ];
};

/**
 * The folders on `unswept.imports` that break no folder rule, and the table rows with no file
 * behind them. Reads every file, so it runs on the whole workspace only.
 */
export const staleFolders = (
  root: string,
  files: readonly SourceFile[],
  tables: FolderTables = FOLDER_TABLES,
): string[] => {
  const breaks = folderBreaks(root, files, tables);
  const present = new Set(
    files.map((f) => placeOf(root, f.path)).map((p) => `${p?.pkg}:${p?.folder}`),
  );

  return PACKAGES.flatMap((pkg) => [
    ...Object.keys(tables[pkg].folders)
      .filter((name) => !present.has(`${pkg}:${name}`))
      .map((name) => `${pkg}'s folder table has ${name}, but no file is in it`),
    ...tables[pkg].unswept.imports
      .filter((name) => !breaks.some((b) => b.pkg === pkg && b.folder === name))
      .map((name) => `${pkg}'s ${name} breaks no folder rule: take it off unswept.imports`),
  ]);
};

/** Every TypeScript file under `root/packages/<package>/src`. */
export const workspaceFiles = (root: string): SourceFile[] =>
  PACKAGES.flatMap((pkg) => {
    const src = join(root, 'packages', pkg, 'src');

    return readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => {
        const path = join(src, name);

        return { path, text: readFileSync(path, 'utf8') };
      });
  });

/** The `abe/` workspace this package lives in. */
export const WORKSPACE = resolve(import.meta.dir, '..', '..', '..');
