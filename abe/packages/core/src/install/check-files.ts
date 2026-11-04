/**
 * `abe check json|yaml <files…>` (ADR 0026): a repo's static checks parse its config files with
 * Abe itself, read-only, needing no tool on the machine (no ruby, no python, no network). Each file
 * parses, or the first one that does not says where (`file:line:column`) and why, exit 1. Pure: the
 * JSON reader and the words; the `abe` client reads the files itself, serve-free, the ports parse
 * YAML.
 */
import { z } from 'zod';

/** Where a text first stops parsing: its line and column (from 1) and why. */
export type ParseError = { line: number; column: number; message: string };

export const CheckFilesData = z.object({
  kind: z.enum(['json', 'yaml']),
  /** Each file that parsed, in the order given. */
  parsed: z.array(z.string()),
});
export type CheckFilesData = z.infer<typeof CheckFilesData>;

export const checkFilesText = (d: CheckFilesData): string =>
  `${d.parsed.length} ${d.kind === 'json' ? 'JSON' : 'YAML'} file${d.parsed.length === 1 ? '' : 's'} parse\n`;

/** The refusal's words for the first file that does not parse. */
export const parseErrorText = (file: string, e: ParseError): string =>
  `${file}:${e.line}:${e.column}: ${e.message}`;

const WS = new Set([' ', '\t', '\n', '\r']);

/**
 * Where a JSON text first stops parsing (RFC 8259: one value, objects, arrays, strings with their
 * escapes, numbers, `true` / `false` / `null`); null: it is JSON.
 */
export const jsonError = (text: string): ParseError | null => {
  let at = 0;
  const fail = (message: string): ParseError => {
    const before = text.slice(0, at).split('\n');

    return {
      line: before.length,
      column: (before.at(-1)?.length ?? 0) + 1,
      message,
    };
  };
  const skip = () => {
    while (at < text.length && WS.has(text.charAt(at))) at++;
  };
  const here = () => (at < text.length ? `"${text.charAt(at)}"` : 'the end');
  const literal = (word: string): ParseError | null => {
    if (!text.startsWith(word, at)) return fail(`unexpected ${here()}`);
    at += word.length;

    return null;
  };
  const string = (): ParseError | null => {
    at++;
    while (at < text.length) {
      const c = text.charAt(at);

      if (c === '"') {
        at++;

        return null;
      }
      if (c === '\\') {
        const e = text.charAt(at + 1);

        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6)))
            return fail('a \\u escape takes 4 hex digits');
          at += 6;
          continue;
        }
        if (!'"\\/bfnrt'.includes(e) || e === '') return fail(`no escape \\${e}`);
        at += 2;
        continue;
      }
      if (c < ' ') return fail('a control character in a string');
      at++;
    }

    return fail('a string not closed');
  };
  const number = (): ParseError | null => {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(at));

    if (m === null || m[0] === '' || m[0] === '-') return fail(`unexpected ${here()}`);
    at += m[0].length;

    return null;
  };
  const value = (depth: number): ParseError | null => {
    if (depth > 512) return fail('nested too deep');
    skip();
    const c = text.charAt(at);

    if (c === '{') return object(depth);
    if (c === '[') return array(depth);
    if (c === '"') return string();
    if (c === 't') return literal('true');
    if (c === 'f') return literal('false');
    if (c === 'n') return literal('null');

    return number();
  };
  const array = (depth: number): ParseError | null => {
    at++;
    skip();
    if (text.charAt(at) === ']') {
      at++;

      return null;
    }
    for (;;) {
      const e = value(depth + 1);

      if (e !== null) return e;
      skip();
      const c = text.charAt(at);

      if (c === ']') {
        at++;

        return null;
      }
      if (c !== ',') return fail(`expected , or ] but found ${here()}`);
      at++;
    }
  };
  const object = (depth: number): ParseError | null => {
    at++;
    skip();
    if (text.charAt(at) === '}') {
      at++;

      return null;
    }
    for (;;) {
      skip();
      if (text.charAt(at) !== '"') return fail(`expected a key in quotes but found ${here()}`);
      const k = string();

      if (k !== null) return k;
      skip();
      if (text.charAt(at) !== ':') return fail(`expected : but found ${here()}`);
      at++;
      const e = value(depth + 1);

      if (e !== null) return e;
      skip();
      const c = text.charAt(at);

      if (c === '}') {
        at++;

        return null;
      }
      if (c !== ',') return fail(`expected , or } but found ${here()}`);
      at++;
    }
  };
  // a byte order mark is no JSON, but editors write one
  if (text.startsWith('\uFEFF')) at = 1;
  const e = value(0);

  if (e !== null) return e;
  skip();

  return at < text.length ? fail(`unexpected ${here()} after the value`) : null;
};
