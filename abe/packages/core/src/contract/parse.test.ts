import { describe, expect, test } from 'bun:test';
import { type CommandId, parse } from '.';

const off = { json: false, noStart: false, help: false };

describe('parse reads argv by the command table', () => {
  test.each<[string[], CommandId, Record<string, unknown>]>([
    [[], 'help', { command: [] }],
    [['help'], 'help', { command: [] }],
    [['help', 'serve', 'stop'], 'help', { command: ['serve', 'stop'] }],
    [['status'], 'status', {}],
    [['serve'], 'serve', {}],
    [['serve', 'stop'], 'serve stop', {}],
    [['prototype', 'discard', 'proto-1a2b3c'], 'prototype discard', { id: 'proto-1a2b3c' }],
    [['prototype', 'list'], 'prototype list', {}],
  ])('%j is %s', (argv, id, args) => {
    expect(parse(argv)).toEqual({ ok: true, id, args, global: off });
  });

  test('global flags go anywhere after the command', () => {
    expect(parse(['status', '--json', '--no-start'])).toEqual({
      ok: true,
      id: 'status',
      args: {},
      global: { json: true, noStart: true, help: false },
    });
  });

  test.each([[['factory']], [['factory', '--json']], [['factory', '--help']]])(
    'a noun with no command of its own (%j) is help on it',
    (argv) => {
      expect(parse(argv)).toMatchObject({
        ok: true,
        id: 'help',
        args: { command: ['factory'] },
        global: { help: false },
      });
    },
  );

  test('a bare flag is help', () => {
    expect(parse(['--json'])).toMatchObject({ ok: true, id: 'help', global: { json: true } });
  });

  test.each([
    [['frob'], undefined, 'unknown-command', 'unknown command: frob'],
    [['constructor'], undefined, 'unknown-command', 'unknown command: constructor'],
    [['toString'], undefined, 'unknown-command', 'unknown command: toString'],
    [['status', '--to-string'], 'status', 'usage', 'unknown flag --to-string'],
    [['status', '--constructor'], 'status', 'usage', 'unknown flag --constructor'],
    [['status', '--frob'], 'status', 'usage', 'unknown flag --frob'],
    [['status', '-x'], 'status', 'usage', 'unknown flag -x'],
    [['status', 'extra'], 'status', 'usage', 'unexpected argument extra'],
    [['serve', 'frob'], 'serve', 'usage', 'unexpected argument frob'],
    [['factory', '103'], undefined, 'unknown-command', 'unknown command: factory 103'],
    [['factory', 'frob', '--help'], undefined, 'unknown-command', 'unknown command: factory frob'],
    [['status', '--json=yes'], 'status', 'usage', '--json takes no value'],
  ])('%j is refused with %s', (argv, id, code, message) => {
    expect(parse(argv)).toMatchObject({ ok: false, id, code, message });
  });

  test('a refusal still knows --json was asked', () => {
    expect(parse(['status', '--frob', '--json'])).toMatchObject({
      ok: false,
      global: { json: true },
    });
    expect(parse(['frob', '--json'])).toMatchObject({ ok: false, global: { json: true } });
  });

  test('-- ends the flags', () => {
    expect(parse(['help', '--', '--json'])).toEqual({
      ok: true,
      id: 'help',
      args: { command: ['--json'] },
      global: off,
    });
  });
});

describe('repeating and number flags, as Tracking types them', () => {
  test('a repeating flag collects every value, a number flag stays text until validated', () => {
    expect(
      parse([
        'issue',
        'create',
        '--repo',
        'a/b',
        '--title',
        'T',
        '--body-file',
        'b.md',
        '--label',
        'x',
        '--label=y',
        '--parent',
        '7',
      ]),
    ).toEqual({
      ok: true,
      id: 'issue create',
      args: { repo: 'a/b', title: 'T', bodyFile: 'b.md', label: ['x', 'y'], parent: '7' },
      global: off,
    });
  });

  // a markdown list or a dash-led sentence is a value, not a flag
  test.each([
    ['- a', '- a'],
    ['-  [ ] it saves', '-  [ ] it saves'],
    ['-', '-'],
  ])('--criteria %j is its value', (value, criteria) => {
    expect(parse(['card', 'create', '--title', 'T', '--criteria', value])).toMatchObject({
      ok: true,
      id: 'card create',
      args: { title: 'T', criteria },
    });
  });

  test.each([
    [['issue', 'show'], 'missing ref'],
    [['issue', 'create', '--repo', 'a/b', '--title', 'T'], '--body-file is required'],
    [['pr', 'show', 'a/b#1', '--draft'], 'unknown flag --draft'],
    [
      ['pr', 'merge', 'a/b#1', '--method', 'fast'],
      '--method: Invalid option: expected one of "merge"|"squash"|"rebase"',
    ],
    [
      ['pr', 'update', 'a/b#1', '--title', 'x', '--title', 'y', '--body-file', 'b'],
      '--title is given twice',
    ],
  ])('%j is refused: %s', (argv, message) => {
    expect(parse(argv)).toMatchObject({ ok: false, code: 'usage', message });
  });
});
