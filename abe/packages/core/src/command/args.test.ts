import { describe, expect, test } from 'bun:test';
import { type ArgsOf, type ArgsSpec, argsSchema, argInfo } from '.';

/** A spec with every kind of argument, as a later command would write it. */
const SPEC = {
  card: { kind: 'positional', type: 'string', required: true, summary: 'the card' },
  rest: { kind: 'positional', type: 'string', repeats: true, summary: 'more' },
  on: { kind: 'flag', type: 'string', summary: 'the box' },
  size: { kind: 'flag', type: 'string', values: ['small', 'large'], summary: 'how big' },
  count: { kind: 'flag', type: 'number', summary: 'how many' },
  dryRun: { kind: 'flag', type: 'boolean', summary: 'only say' },
} as const satisfies ArgsSpec;

describe('argsSchema validates what ArgsOf types', () => {
  test('fills defaults and coerces numbers', () => {
    const parsed: ArgsOf<typeof SPEC> = argsSchema(SPEC).parse({ card: '12', count: '3' });

    expect(parsed).toEqual({ card: '12', rest: [], count: 3, dryRun: false });
  });

  test.each([
    [{}, 'card'],
    [{ card: '1', size: 'huge' }, 'size'],
    [{ card: '1', count: 'many' }, 'count'],
    [{ card: '1', other: 'x' }, ''],
  ])('refuses %j at %s', (raw, at) => {
    const result = argsSchema(SPEC).safeParse(raw);

    expect(result.success).toBe(false);
    expect(String(result.error?.issues[0]?.path[0] ?? '')).toBe(at);
  });

  test('an empty word is refused, except in a verbatim argument', () => {
    expect(argsSchema(SPEC).safeParse({ card: '1', rest: ['a', ''] }).success).toBe(false);
    const verbatim = { argv: { ...SPEC.rest, verbatim: true } } as const satisfies ArgsSpec;

    expect(argsSchema(verbatim).parse({ argv: ['sh', '', 'x'] })).toEqual({
      argv: ['sh', '', 'x'],
    });
  });

  test('help lists a flag by its kebab name', () => {
    expect(argInfo('dryRun', SPEC.dryRun)).toEqual({
      name: 'dry-run',
      kind: 'flag',
      type: 'boolean',
      required: false,
      repeats: false,
      summary: 'only say',
    });
    expect(argInfo('size', SPEC.size)).toMatchObject({ type: 'enum', values: ['small', 'large'] });
  });
});
