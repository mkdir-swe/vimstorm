/** A Layer file written back (#176): only the edited key's lines change; comments and flow style stay. */
import { describe, expect, test } from 'bun:test';
import { yamlText } from './settings';

describe('yamlText: a layer file edited in place', () => {
  const text = [
    '# the team Layer',
    'allowedModels: [opus, sonnet]',
    'testFiles: ["*.qa.*"]',
    'tabs:',
    '  limit: 4',
    '',
  ].join('\n');

  test('a changed key changes its own line only: flow sequences keep their style', () => {
    const out = yamlText(text, {
      allowedModels: ['opus', 'sonnet'],
      testFiles: ['*.qa.*'],
      tabs: { limit: 6 },
    });

    expect(out).toBe(text.replace('limit: 4', 'limit: 6'));
  });

  test('a new key is added, the rest as it was', () => {
    const out = yamlText(text, {
      allowedModels: ['opus', 'sonnet'],
      testFiles: ['*.qa.*'],
      tabs: { limit: 4 },
      autoMerge: false,
    });

    expect(out).toBe(`${text}autoMerge: false\n`);
  });

  test('untouched flow maps and lists stay byte for byte, padded or not', () => {
    const team = [
      '# the web team',
      'board: { project: Shop }',
      'tight: {a: 1}',
      'models: [ opus ]',
      "quoted: 'x'   # kept",
      'nested:',
      '    deep: { k: v }',
      '    n: 1',
      '',
    ].join('\n');
    const out = yamlText(team, {
      board: { project: 'Shop' },
      tight: { a: 1 },
      models: ['opus'],
      quoted: 'x',
      nested: { deep: { k: 'v' }, n: 2 },
      skillsOnTop: true,
    });

    expect(out).toBe(`${team.replace('    n: 1', '    n: 2')}skillsOnTop: true\n`);
  });

  test.each<[string, string | undefined, unknown, string]>([
    ['added to a file', 'team: web\n', { team: 'web', role: null }, 'team: web\nrole: null\n'],
    ['the only key of a new file', undefined, { team: null }, 'team: null\n'],
    [
      'added in a block of its own',
      'checkouts:\n  /x:\n    a: 1\n',
      { checkouts: { '/x': { a: 1, team: null } } },
      'checkouts:\n  /x:\n    a: 1\n    team: null\n',
    ],
  ])('a null is written as key: null, never the explicit ? form: %s', (_, before, doc, want) => {
    expect(yamlText(before, doc)).toBe(want);
  });

  test('a dropped key takes only its own lines', () => {
    const out = yamlText(text, { allowedModels: ['opus', 'sonnet'], tabs: { limit: 4 } });

    expect(out).toBe(text.replace('testFiles: ["*.qa.*"]\n', ''));
  });

  test('a changed entry keeps the comment above it once; a file without a last newline gets one', () => {
    const out = yamlText('a: 1\n# about b\nb: { x: 1 }', { a: 1, b: { x: 2 }, c: [1] });

    expect(out).toBe('a: 1\n# about b\nb: {x: 2}\nc:\n  - 1\n');
  });

  test('a map emptied stays a map', () => {
    expect(
      yamlText(text, { allowedModels: ['opus', 'sonnet'], testFiles: ['*.qa.*'], tabs: {} }),
    ).toBe(text.replace('tabs:\n  limit: 4\n', 'tabs: {}\n'));
  });
});
