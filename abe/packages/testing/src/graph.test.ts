import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  checkGraph,
  FOLDER_TABLES,
  type FolderTable,
  type SourceFile,
  staleFolders,
  WORKSPACE,
  workspaceFiles,
} from './graph';

const at = (pkg: string, name: string) => join(WORKSPACE, 'packages', pkg, 'src', name);

const planted = (pkg: string, text: string, name = 'planted.ts'): SourceFile => ({
  path: at(pkg, name),
  text,
});

const files = workspaceFiles(WORKSPACE);

describe('the dependency graph', () => {
  test('every package imports only what the platform spec allows', () => {
    expect(checkGraph(WORKSPACE, files)).toEqual([]);
  });

  test('every unswept folder still breaks a folder rule, and every folder has files', () => {
    expect(staleFolders(WORKSPACE, files)).toEqual([]);
  });

  test.each([
    ['core', "import { readFileSync } from 'node:fs';", 'core may not use Node or Bun built-ins'],
    ['core', "import { listen } from '@abe/ports';", 'core may not import ports'],
    ['core', "import express from 'express';", 'core may not import express'],
    ['ui', "import { COMMANDS } from '@abe/core';", 'ui may import only types from core'],
    ['ui', "import { type Serve } from '@abe/serve';", 'ui may not import serve'],
    ['hooks', "import { listen } from '@abe/ports';", 'hooks may not import ports'],
    ['hooks', "import { COMMANDS } from '@abe/core';", 'hooks may import only types from core'],
    ['hooks', "import { x } from '@abe/core/session';", 'hooks may import only types from core'],
    ['serve', "import { cli } from '@abe/testing';", 'serve may not import testing'],
    ['ports', "export { startServe } from '@abe/serve';", 'ports may not import serve'],
    ['ports', "const s = await import('../../serve/src/server');", 'ports may not import serve'],
    ['core', "import x from '../../../../outside';", "outside the workspace's packages"],
  ])('a planted import in %s fails it: %s', (pkg, text, why) => {
    const broken = checkGraph(WORKSPACE, [...files, planted(pkg, text)]);

    expect(broken).toHaveLength(1);
    expect(broken[0]).toContain(`packages/${pkg}/src/planted.ts:1 imports`);
    expect(broken[0]).toContain(why);
  });

  test.each([
    ['ui', "import type { StatusData } from '@abe/core';"],
    ['ui', "import { type StatusData } from '@abe/core';"],
    ['hooks', "import { createConnection } from 'node:net';"],
    ['hooks', "const { withRealPaths } = await import('@abe/core/permission');"],
    ['core', "import { z } from 'zod';"],
    ['serve', "import { listen } from '@abe/ports';"],
  ])('allowed in %s: %s', (pkg, text) => {
    expect(checkGraph(WORKSPACE, [planted(pkg, text)])).toEqual([]);
  });

  test('test files may import the harness and other packages', () => {
    const test = { path: at('core', 'x.test.ts'), text: "import { cli } from '@abe/testing';" };

    expect(checkGraph(WORKSPACE, [test])).toEqual([]);
  });
});

/** Core as folders `a` to `d`: `a` may import `b` (interface `main.ts`) and `c`. */
const ABC: FolderTable = {
  folders: {
    a: { imports: ['b', 'c'], seams: ['seam.ts'] },
    b: { imports: [], interface: 'main.ts' },
    c: { imports: [] },
    d: { imports: [] },
  },
  unswept: { imports: [], prose: [] },
};

const swept = { imports: [], prose: [] };

/** The real tables with nothing unswept, and core's replaced by `core`. */
const withCore = (core: FolderTable) => ({
  core,
  ports: { ...FOLDER_TABLES.ports, unswept: swept },
  serve: { ...FOLDER_TABLES.serve, unswept: swept },
  ui: { ...FOLDER_TABLES.ui, unswept: swept },
  hooks: { ...FOLDER_TABLES.hooks, unswept: swept },
  testing: { ...FOLDER_TABLES.testing, unswept: swept },
});

describe('the folder rules', () => {
  test.each([
    ['core', 'a/x.ts', "import { y } from '../b/private';", 'past the interface of b (b/main.ts)'],
    ['core', 'a/x.ts', "import { y } from '../b';", 'past the interface of b (b/main.ts)'],
    ['core', 'a/x.ts', "import { y } from '../d';", 'a may not import d'],
    ['core', 'b/x.ts', "import { y } from '../a';", 'b may not import a'],
    ['core', 'a/x.ts', "import { y } from '../nowhere/x';", "nowhere is not a folder in core's"],
    ['core', 'a/x.ts', "import { y } from '../x';", ". is not a folder in core's"],
    ['core', 'z/x.ts', "import { z } from 'zod';", "z is not a folder in core's folder table"],
    [
      'core',
      'a/x.test.ts',
      "import { y } from './private';",
      "a test imports its folder's interface",
    ],
    ['core', 'a/x.test.ts', "import { y } from '../b/private';", 'past the interface of b'],
    ['core', 'a/x.test.ts', "import { y } from '../d';", 'a may not import d'],
    ['serve', 'x.ts', "import { y } from '@abe/core/nope';", 'not an entry point of core'],
    [
      'serve',
      'x.ts',
      "import { y } from '@abe/core/permission';",
      "past the interface of core's session",
    ],
    [
      'ports',
      'x.ts',
      "import { y } from '../../core/src/a/private';",
      "past the interface of core's a",
    ],
    ['ui', 'x.test.ts', "import { y } from '../../core/src/b/private';", "interface of core's b"],
  ])('%s/src/%s fails: %s', (pkg, name, text, why) => {
    const broken = checkGraph(WORKSPACE, [planted(pkg, text, name)], withCore(ABC));

    expect(broken).toHaveLength(1);
    expect(broken[0]).toContain(`packages/${pkg}/src/${name}:`);
    expect(broken[0]).toContain(why);
  });

  test.each([
    ['core', 'a/x.ts', "import { y } from '../b/main';"],
    ['core', 'a/x.ts', "import { y } from '../c';"],
    ['core', 'a/x.ts', "import { y } from '../c/index';"],
    ['core', 'a/x.ts', "import { y } from './private';"],
    ['core', 'a/x.test.ts', "import { y } from '.';"],
    ['core', 'a/x.test.ts', "import { y } from './index';"],
    ['core', 'a/x.test.ts', "import { y } from './seam';"],
    ['core', 'a/x.test.ts', "import { y } from '../c';"],
    ['core', 'a/x.test.ts', "import { cli } from '@abe/testing';"],
    ['serve', 'x.ts', "import { y } from '@abe/core';"],
    ['core', 'a/x.ts', "import y from '../../skills/y.md';"],
  ])('allowed in %s/src/%s: %s', (pkg, name, text) => {
    expect(checkGraph(WORKSPACE, [planted(pkg, text, name)], withCore(ABC))).toEqual([]);
  });

  test('an unswept folder may still import past an interface', () => {
    const core = { ...ABC, unswept: { imports: ['a'], prose: [] } };
    const text = "import { y } from '../b/private';";

    expect(checkGraph(WORKSPACE, [planted('core', text, 'a/x.ts')], withCore(core))).toEqual([]);
  });

  test.each([
    [
      { a: { imports: ['b'] }, b: { imports: ['a'] } },
      "core's folder table has a cycle: a → b → a",
    ],
    [
      { a: { imports: ['b'] }, b: { imports: ['c'] }, c: { imports: ['a'] } },
      "core's folder table has a cycle: a → b → c → a",
    ],
    [{ a: { imports: ['d'] } }, "core's folder a imports names d, not a folder"],
  ])('a table that breaks itself fails: %j', (folders, why) => {
    const core = { folders, unswept: { imports: [], prose: [] } };

    expect(checkGraph(WORKSPACE, [], withCore(core))).toEqual([why]);
  });

  test.each([
    [
      ['a'],
      "import { y } from '../c';",
      "core's a breaks no folder rule: take it off unswept.imports",
    ],
    [[], "import { y } from '../c';", "core's folder table has d, but no file is in it"],
  ])('a stale table fails: unswept %j, a/x.ts %s', (unswept, text, why) => {
    const core = { ...ABC, unswept: { imports: unswept, prose: [] } };
    const stale = staleFolders(
      WORKSPACE,
      [...files, planted('core', text, 'a/x.ts')],
      withCore(core),
    );

    expect(stale).toContain(why);
  });
});
