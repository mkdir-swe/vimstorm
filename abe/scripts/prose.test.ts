import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkProse, filesUnder, findings, REPO, ROOTS } from './prose';

const DASH = '—';

describe('the prose check', () => {
  test('the repository breaks nothing outside the unswept places, and none of those is clean', () => {
    expect(checkProse(REPO, filesUnder(REPO, ROOTS))).toEqual({ broken: [], stale: [] });
  });

  test.each([
    ['a.ts', '// fixed in #213\nconst a = 1;', 'issue #213'],
    ['a.ts', '/** Read as in vimstorm#25. */\nconst a = 1;', 'issue vimstorm#25'],
    ['a.ts', '// see github.com/o/r/issues/7\nconst a = 1;', 'issue /issues/7'],
    ['a.ts', '// see github.com/o/r/pull/8\nconst a = 1;', 'issue /pull/8'],
    ['a.ts', "const a = 1; // the end (#9)\nconst b = 'x';", 'issue #9'],
    ['a.ts', `// one way ${DASH} the other\nconst a = 1;`, `dash ${DASH}`],
    ['a.ts', '// Additionally, it runs\nconst a = 1;', 'word Additionally'],
    ['a.ts', '/* this serves as the root */\nconst a = 1;', 'word serves as'],
    ['a.ts', 'function f() {\n  return 1;\n  // a crucial last line\n}', 'word crucial'],
    ['a.test.ts', "test('the bar after #41', () => {});", 'issue #41'],
    ['a.test.ts', 'describe.each([1])(`rows of #12`, () => {});', 'issue #12'],
    ['a.rs', 'fn a() {}\n// the toolbar (#20)', 'issue #20'],
    ['a.rs', `/* outer /* nested */ still ${DASH} a comment */`, `dash ${DASH}`],
    ['a.lua', '-- the tree (#5)\nlocal a = 1', 'issue #5'],
    ['a.lua', '--[[ a block\n that leverages #3 ]]', 'word leverages'],
    ['a.md', '# Title\n\nAs #37 says.', 'issue #37'],
    ['a.md', `A doc ${DASH} with a dash.`, `dash ${DASH}`],
  ])('%s breaks it: %j', (path, text, found) => {
    expect(findings(path, text).map((f) => `${f.kind} ${f.text}`)).toContain(found);
  });

  test.each([
    ['a.ts', "const s = 'PR #12 merged';"],
    ['a.ts', `const s = 'a ${DASH} b';`],
    ['a.ts', '// the color #1e1f22 and `#8` as the board writes it\nconst a = 1;'],
    ['a.ts', '// ADR 0015 keeps the CLI the contract\nconst a = 1;'],
    ['a.test.ts', `test('a ${DASH} b, crucially', () => {});`],
    ['a.rs', 'let s = "// #12 not a comment";\nlet r = r#"// #13 raw"#;'],
    ['a.rs', "#[derive(Debug)]\nfn f<'a>(c: char) -> bool { c == '#' }"],
    ['a.lua', 'local s = "-- #4 in a string"'],
    ['a.md', '```sh\nbun test # #12\n```\n\nSee `#7` and [tests](#tests).'],
    ['a.sh', '# fixed in #1'],
  ])('%s keeps it: %j', (path, text) => {
    expect(findings(path, text)).toEqual([]);
  });

  test('a finding names its line', () => {
    expect(findings('a.ts', 'const a = 1;\n\n// #3\n')).toEqual([
      { line: 3, kind: 'issue', text: '#3' },
    ]);
  });
});

describe('the unswept places', () => {
  const repo = mkdtempSync(join(tmpdir(), 'prose-'));
  const plant = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);

    return path;
  };
  const dirty = plant('abe/packages/core/src/a/x.ts', '// #1\n');
  const clean = plant('abe/packages/core/src/b/x.ts', '// fine\n');
  const doc = plant('docs/x.md', 'As #2 says.\n');
  const none = { folders: {}, unswept: { imports: [], prose: [] } };
  const tables = (prose: string[]) => ({
    core: { folders: {}, unswept: { imports: [], prose } },
    ports: none,
    serve: none,
    ui: none,
    hooks: none,
    testing: none,
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test.each([
    [[], [], ['abe/packages/core/src/a/x.ts:1: issue #1', 'docs/x.md:1: issue #2'], []],
    [['a'], ['docs'], [], []],
    [
      ['a', 'b'],
      ['docs', 'GLOSSARY.md'],
      [],
      [
        "core's b on unswept.prose has nothing left to fix: take it off",
        'GLOSSARY.md on UNSWEPT has nothing left to fix: take it off',
      ],
    ],
  ])('core %j and %j unswept', (prose, outside, broken, stale) => {
    const found = checkProse(repo, [dirty, clean, doc], tables(prose), outside);

    expect(found).toEqual({ broken, stale });
  });
});
