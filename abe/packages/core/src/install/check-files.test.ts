/** `abe check json`'s reader: JSON as RFC 8259 says it, the first error's line and column. */
import { describe, expect, test } from 'bun:test';
import { jsonError } from './check-files';

const isJson = (text: string) => {
  try {
    JSON.parse(text);

    return true;
  } catch {
    return false;
  }
};

describe('jsonError: JSON or where it stops', () => {
  test.each<[string, string, string | null]>([
    ['an object', '{ "a": [1, -2.5e3, true, false, null, "x\\n\\u00e9"] }\n', null],
    ['a bare value', '"text"', null],
    ['empty object and array', '{"a":{},"b":[]}', null],
    ['a byte order mark first', '\uFEFF{}', null],
    ['a mark a template fills in', '{\n  "API_ENV": API_ENV_SED\n}\n', '2:14 unexpected "A"'],
    ['a trailing comma', '{ "a": 1, }', '1:11 expected a key in quotes but found "}"'],
    ['an unquoted key', '{ a: 1 }', '1:3 expected a key in quotes but found "a"'],
    ['a string not closed', '{ "a": "b }', '1:12 a string not closed'],
    ['a bad escape', '"\\x"', '1:2 no escape \\x'],
    ['a leading zero', '01', '1:2 unexpected "1" after the value'],
    ['a comment', '{} // no', '1:4 unexpected "/" after the value'],
    ['nothing', '', '1:1 unexpected the end'],
    ['single quotes', "{ 'a': 1 }", '1:3 expected a key in quotes but found "\'"'],
  ])('%s', (_, text, want) => {
    const e = jsonError(text);

    expect(e === null ? null : `${e.line}:${e.column} ${e.message}`).toBe(want);
    // it takes what JSON.parse takes, a mark first aside
    expect(e === null).toBe(isJson(text.replace(/^\uFEFF/, '')));
  });
});
