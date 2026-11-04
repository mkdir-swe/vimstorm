/** The checks the written files name come from the one list: `abe.yaml`'s `checks:`. */
import { describe, expect, test } from 'bun:test';
import { type ListedCheck, notACheckLines, unlistedChecks } from './install-check-list';

const SCRIPTS = {
  test: 'node --test',
  prettier: 'prettier --check .',
  'lint:fix': 'eslint --fix .',
  build: 'tsc -p .',
};
const LISTED: ListedCheck[] = [
  { name: 'tests', run: 'npm test' },
  { name: 'setup', run: 'npm ci' },
];
const CI = ['npm ci', 'npm test', 'npm run prettier', 'npx tsc --noEmit'];

describe('unlistedChecks: a check a written file names that settings.yaml does not list', () => {
  const PRETTIER = { name: 'prettier', run: 'npm run prettier' };

  test.each<[string, ListedCheck[], Record<string, string>, [string, string][]]>([
    [
      'prettier in CLAUDE.md and verify-<app>, left out of settings.yaml',
      LISTED,
      {
        'CLAUDE.md': '## Running and checking\n\n- `npm run prettier`: formatting\n',
        '.claude/skills/verify-shop/SKILL.md': '| formatting | `npm run prettier` |\n',
      },
      [
        ['CLAUDE.md', 'npm run prettier'],
        ['.claude/skills/verify-shop/SKILL.md', 'npm run prettier'],
      ],
    ],
    [
      'said as not a check yet, with why',
      LISTED,
      { 'CLAUDE.md': 'Not a check yet: `npm run prettier` (prettier is not installed here).\n' },
      [],
    ],
    [
      'prettier listed: every file may name it',
      [...LISTED, PRETTIER],
      {
        'CLAUDE.md': '`npm run prettier`\n',
        '.claude/skills/verify-shop/SKILL.md': '`npm run prettier`\n',
      },
      [],
    ],
    [
      'a CI command, in the testing skill',
      LISTED,
      { '.claude/skills/shop-testing/SKILL.md': 'Types: `npx tsc --noEmit`\n' },
      [['.claude/skills/shop-testing/SKILL.md', 'npx tsc --noEmit']],
    ],
    [
      'the listed ones, setup, a script that is no check and a longer script name: fine',
      LISTED,
      {
        'CLAUDE.md':
          'Run `npm test`. Install with `npm ci`. `npm run build`. `npm run lint:fix`.\n',
      },
      [],
    ],
  ])('%s', (_, listed, files, want) => {
    expect(
      unlistedChecks({
        listed,
        scripts: SCRIPTS,
        ci: CI,
        files: new Map(Object.entries(files)),
      }).map((u) => [u.file, u.command]),
    ).toEqual(want);
  });
});

describe('notACheckLines: a check the files name that the list leaves out is a note, once', () => {
  const PRETTIER = { file: 'CLAUDE.md', command: 'npm run prettier' };

  test.each<[string, Record<string, { ok: boolean; exit: number | null; at: string }>, string[]]>([
    ['not tried', {}, ['Not a check yet: `npm run prettier` (not tried at Checks)']],
    [
      'failed when serve ran it',
      { 'npm run prettier': { ok: false, exit: 2, at: 't' } },
      ['Not a check yet: `npm run prettier` (it failed when serve ran it at Checks, exit 2)'],
    ],
  ])('%s', (_, runs, lines) => {
    expect(
      notACheckLines(
        [PRETTIER, { ...PRETTIER, file: '.claude/skills/verify-shop/SKILL.md' }],
        runs,
      ),
    ).toEqual(lines);
  });
});
