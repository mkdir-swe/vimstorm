/** Rule tables for Improve: personal-Layer paths, roles, the agent's answer, undo's depth, the daily limit. */
import { describe, expect, test } from 'bun:test';
import {
  applyEntryDiff,
  changedFiles,
  checkPaths,
  entryDiff,
  IMPROVE_SKILL,
  improvePrompt,
  mapFileProblem,
  maySuggest,
  ownSettingsProblems,
  personalPath,
  pushUndo,
  readImprove,
  readKeysText,
  staleFiles,
  SUGGEST_EVERY_MS,
  UNDO_DEPTH,
  type UndoEntry,
} from './improve';
import { expandPersonal, personalCommandsOf } from './personal-commands';

describe('personalPath: only the personal Layer, the Neovim config for developers', () => {
  test.each([
    ['settings.yaml', 'settings'],
    ['keys.json', 'keys'],
    ['commands.yaml', 'commands'],
    ['skills/standup/SKILL.md', 'skill'],
    ['nvim/init.lua', 'nvim'],
    ['nvim/lua/me/keys.lua', 'nvim'],
  ] as const)('%s is %s for a developer', (path, kind) => {
    expect(personalPath(path)).toEqual({ ok: true, path, kind });
  });

  test.each([
    '/etc/passwd',
    '~/.config/abe/settings.yaml',
    '../settings.yaml',
    'skills/../../x',
    './settings.yaml',
    'skills/standup/notes.md',
    'skills/Standup/SKILL.md',
    'skills/SKILL.md',
    'nvim',
    'nvim/.git/config',
    'org.yaml',
    'settings.yaml/x',
    '',
    'a\\b',
    'teams/web/settings.yaml',
  ])('%s is outside the personal Layer', (path) => {
    expect(personalPath(path)).toMatchObject({
      ok: false,
      code: 'outside-personal-layer',
    });
  });

  test('checkPaths names every path refused, and a path given twice', () => {
    expect(
      checkPaths([
        { path: 'keys.json', after: '{}' },
        { path: '/etc/hosts', after: '' },
        { path: 'nvim/init.lua', after: '' },
      ]),
    ).toEqual({
      ok: false,
      code: 'outside-personal-layer',
      message: 'outside your personal Layer: /etc/hosts',
    });
    expect(
      checkPaths([
        { path: 'keys.json', after: '{}' },
        { path: 'keys.json', after: '[]' },
      ]),
    ).toMatchObject({ ok: false, code: 'invalid-proposal' });
  });
});

describe('readImprove: the agent’s answer', () => {
  test('a change, in a fence', () => {
    const text =
      'Here:\n```json\n{"kind":"change","summary":"Show the terminal","files":[{"path":"settings.yaml","after":"x: 1\\n"}]}\n```';

    expect(readImprove(text)).toEqual({
      ok: true,
      answer: {
        kind: 'change',
        summary: 'Show the terminal',
        files: [{ path: 'settings.yaml', after: 'x: 1\n' }],
      },
    });
  });

  test('a code wish and nothing to do', () => {
    expect(
      readImprove('{"kind":"needs-code","title":"A new view","body":"It needs one."}'),
    ).toEqual({
      ok: true,
      answer: { kind: 'needs-code', title: 'A new view', body: 'It needs one.' },
    });
    expect(readImprove('{"kind":"nothing","reason":"It does that already."}')).toMatchObject({
      ok: true,
      answer: { kind: 'nothing' },
    });
  });

  test.each([
    'I would change your keys.',
    '{"kind":"change","summary":"x","files":[]}',
    '{"kind":"delete-everything"}',
  ])('unreadable: %s', (text) => {
    expect(readImprove(text).ok).toBe(false);
  });
});

describe('changedFiles and staleFiles', () => {
  test('a file the change leaves as it is drops out; null is no file', () => {
    expect(
      changedFiles(
        [
          { path: 'keys.json', after: '{"a":1}' },
          { path: 'commands.yaml', after: 'x: [status]\n' },
          { path: 'skills/old/SKILL.md', after: null },
        ],
        { 'keys.json': '{"a":1}', 'commands.yaml': null, 'skills/old/SKILL.md': '# old\n' },
      ),
    ).toEqual([
      { path: 'commands.yaml', before: null, after: 'x: [status]\n' },
      { path: 'skills/old/SKILL.md', before: '# old\n', after: null },
    ]);
  });

  test('stale: a file no longer as the proposal found it', () => {
    const files = [
      { path: 'keys.json', before: '{}', after: '{"a":1}' },
      { path: 'commands.yaml', before: null, after: 'x: [status]\n' },
    ];

    expect(staleFiles(files, { 'keys.json': '{}', 'commands.yaml': null })).toEqual([]);
    expect(staleFiles(files, { 'keys.json': '{"b":2}', 'commands.yaml': 'y: [status]\n' })).toEqual(
      ['keys.json', 'commands.yaml'],
    );
  });
});

describe('pushUndo: up to 20 applied states, the oldest dropped', () => {
  const entry = (n: number): UndoEntry => ({
    id: `imp-${String(n).padStart(6, '0')}`,
    at: '2026-10-23T10:00:00.000Z',
    files: [],
  });

  test('the 21st push drops the first', () => {
    let stack: UndoEntry[] = [];

    for (let n = 1; n <= UNDO_DEPTH + 1; n += 1) stack = pushUndo(stack, entry(n));
    expect(stack).toHaveLength(20);
    expect(stack[0]?.id).toBe('imp-000002');
    expect(stack.at(-1)?.id).toBe('imp-000021');
  });
});

describe('maySuggest: opt-in, at most once in 24 hours', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');

  test.each([
    [false, undefined, 'suggest-off'],
    [true, undefined, null],
    [true, now - SUGGEST_EVERY_MS, null],
    [true, now - SUGGEST_EVERY_MS + 1, 'suggested-today'],
    [true, now - 60_000, 'suggested-today'],
    [false, now - 60_000, 'suggest-off'],
  ] as const)('enabled %p, last %p → %p', (enabled, last, code) => {
    const may = maySuggest({ enabled, last, now });

    expect(may.ok ? null : may.code).toBe(code);
  });

  test('a refusal says when the next one may come', () => {
    const may = maySuggest({ enabled: true, last: now - 60_000, now });

    expect(may).toMatchObject({ ok: false, next: now - 60_000 + SUGGEST_EVERY_MS });
  });
});

describe('entryDiff: a map file change, entry by entry', () => {
  test('an entry diff moves only what the proposal changed onto another file', () => {
    const diff = entryDiff(
      { a: 1, b: 2, overrides: { autoMerge: { value: true, reason: 'x' } } },
      { a: 1, b: 3, c: 4, overrides: {} },
    );

    expect(diff).toEqual({
      set: [
        [['b'], 3],
        [['c'], 4],
      ],
      removed: [['overrides', 'autoMerge']],
    });
    expect(
      applyEntryDiff(
        { a: 9, b: 2, overrides: { autoMerge: { value: true, reason: 'x' }, other: 1 } },
        diff,
      ),
    ).toEqual({ a: 9, b: 3, c: 4, overrides: { other: 1 } });
    expect(applyEntryDiff(undefined, diff)).toEqual({ b: 3, c: 4 });
  });
});

describe('improvePrompt: the wish, the role, the keys, the formats, the files', () => {
  test('it names what the agent may change and how to answer', () => {
    const prompt = improvePrompt({
      wish: 'show the terminal again',
      files: [{ path: 'settings.yaml', text: 'ui.theme: islands-dark\n' }],
      nvim: [],
    });

    expect(prompt).toContain('show the terminal again');
    expect(prompt).toContain('- `allowedModels`');
    expect(prompt).toContain('### settings.yaml\n\n```\nui.theme: islands-dark\n```');
    expect(prompt).toContain('"kind": "needs-code"');
    expect(IMPROVE_SKILL).not.toContain('---\nname:');
  });
});

describe('personal commands: a word → an abe argv', () => {
  const nouns = new Set(['card', 'status', 'improve']);

  test('read from commands.yaml, both forms', () => {
    expect(
      personalCommandsOf({
        mine: ['card', 'list'],
        st: { argv: ['status'], summary: 'how serve is' },
      }),
    ).toEqual({
      ok: true,
      commands: [
        { name: 'mine', argv: ['card', 'list'], summary: null },
        { name: 'st', argv: ['status'], summary: 'how serve is' },
      ],
    });
    expect(personalCommandsOf(undefined)).toEqual({ ok: true, commands: [] });
  });

  test.each([[{ Mine: ['card'] }], [{ mine: [] }], [{ mine: 'card list' }], [['card']]])(
    'refused: %j',
    (doc) => {
      expect(personalCommandsOf(doc).ok).toBe(false);
    },
  );

  test('expanded only for a word no command has, into a command’s argv, with the rest after it', () => {
    const commands = [
      { name: 'mine', argv: ['card', 'list'], summary: null },
      { name: 'status', argv: ['card', 'list'], summary: null },
      { name: 'loop', argv: ['mine'], summary: null },
    ];

    expect(expandPersonal(['mine', '--json'], commands, nouns)).toEqual(['card', 'list', '--json']);
    expect(expandPersonal(['status'], commands, nouns)).toBeUndefined();
    expect(expandPersonal(['loop'], commands, nouns)).toBeUndefined();
    expect(expandPersonal(['other'], commands, nouns)).toBeUndefined();
  });
});

describe('the files’ contents', () => {
  const nouns = new Set(['status', 'card']);

  test.each([
    ['keys', readKeysText('{"⌘5": "chat.toggle"}'), undefined],
    ['keys', readKeysText('[1]'), 'keys.json is a JSON object: a key → its action'],
    ['keys', readKeysText('{'), 'keys.json is not JSON'],
    ['commands', { doc: { st: ['status'] } }, undefined],
    [
      'commands',
      { doc: { st: ['nothing'] } },
      'commands.yaml: st runs nothing, which is no abe command',
    ],
    ['commands', { doc: { status: ['card'] } }, "commands.yaml: status is abe's own command"],
    ['settings', { doc: { anything: 1 } }, undefined],
  ] as const)('%s %j → %p', (kind, read, problem) => {
    expect(mapFileProblem(kind, read, nouns)).toBe(problem);
  });

  test('only your own file’s problems refuse a proposal', () => {
    const problem = (key: string, file: string) => ({
      code: 'unknown-setting' as const,
      layer: 'individual' as const,
      file,
      key,
      message: `${key} is not a setting`,
    });

    expect(
      ownSettingsProblems(
        [problem('colour', '/me/settings.yaml'), problem('size', '/r/abe.yaml')],
        '/me/settings.yaml',
      ).map((p) => p.key),
    ).toEqual(['colour']);
  });
});
