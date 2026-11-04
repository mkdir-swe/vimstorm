/**
 * VS Code's settings and keybindings files are JSON with comments (`//`, `/* *\/`) and trailing
 * commas. Both are blanked outside strings (newlines kept, so a place still has its line), then
 * the text is read as JSON; a text that does not read says where (`line 3, column 5: …`).
 */
export type JsoncRead = { doc: unknown } | { error: string };

/** Where the next character that is no space and no comment starts, from `i`. */
const nextCode = (text: string, from: number): number => {
  let i = from;

  while (i < text.length) {
    if (/\s/.test(text.charAt(i))) i += 1;
    else if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);

      i = end === -1 ? text.length : end;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);

      i = end === -1 ? text.length : end + 2;
    } else return i;
  }

  return i;
};

/** A comment's text as blanks, its newlines kept. */
const blank = (s: string) => s.replace(/[^\n]/g, ' ');

/** The text as JSON reads it: comments and trailing commas blanked; where a comment never closes. */
const blanked = (raw: string): { text: string; unclosed?: number } => {
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  let out = '';
  let i = 0;

  while (i < text.length) {
    const c = text.charAt(i);
    const next = text.charAt(i + 1);

    if (c === '"') {
      let j = i + 1;

      while (j < text.length && text.charAt(j) !== '"') j += text.charAt(j) === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const to = end === -1 ? text.length : end;

      out += blank(text.slice(i, to));
      i = to;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);

      if (end === -1) return { text: out, unclosed: i };
      out += blank(text.slice(i, end + 2));
      i = end + 2;
    } else if (c === ',' && ['}', ']'].includes(text.charAt(nextCode(text, i + 1)))) {
      // a trailing comma: dropped
      out += ' ';
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }

  return { text: out };
};

/**
 * The text with comments and trailing commas removed (a leading byte order mark too); strings are
 * kept as written.
 */
export const stripJsonc = (raw: string): string => blanked(raw).text.replace(/[ \t]+$/gm, '');

/** Whether the text holds nothing but space and closed comments (VS Code reads it as no settings). */
export const isBlankJsonc = (raw: string): boolean => {
  const { text, unclosed } = blanked(raw);

  return unclosed === undefined && text.trim() === '';
};

const SPACE = /[ \t\n\r]*/y;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** Where JSON text first goes wrong, and what was expected there. */
const firstError = (t: string): { at: number; expected: string } | undefined => {
  let i = 0;
  let expected = 'a value';
  const space = () => {
    SPACE.lastIndex = i;
    SPACE.exec(t);
    i = SPACE.lastIndex;
  };
  const string = (): boolean => {
    if (t.charAt(i) !== '"') {
      expected = 'a string';

      return false;
    }
    i += 1;
    while (i < t.length) {
      const c = t.charAt(i);

      if (c === '"') {
        i += 1;

        return true;
      }
      if (c < ' ') break;
      if (c === '\\') {
        const e = t.charAt(i + 1);
        const ok =
          e === 'u'
            ? /^[0-9a-fA-F]{4}$/.test(t.slice(i + 2, i + 6))
            : '"\\/bfnrt'.includes(e) && e !== '';

        if (!ok) {
          expected = 'a JSON escape (\\\\ for a backslash)';

          return false;
        }
        i += e === 'u' ? 6 : 2;
      } else i += 1;
    }
    expected = 'the string to end';

    return false;
  };
  const list = (close: string, item: () => boolean): boolean => {
    i += 1;
    space();
    if (t.charAt(i) === close) {
      i += 1;

      return true;
    }
    for (;;) {
      if (!item()) return false;
      space();
      const c = t.charAt(i);

      if (c === close) {
        i += 1;

        return true;
      }
      if (c !== ',') {
        expected = `, or ${close}`;

        return false;
      }
      i += 1;
      space();
    }
  };
  const value = (): boolean => {
    space();
    const c = t.charAt(i);

    if (c === '{')
      return list('}', () => {
        if (!string()) return false;
        space();
        if (t.charAt(i) !== ':') {
          expected = ':';

          return false;
        }
        i += 1;

        return value();
      });
    if (c === '[') return list(']', value);
    if (c === '"') return string();
    for (const word of ['true', 'false', 'null'])
      if (t.startsWith(word, i)) {
        i += word.length;

        return true;
      }
    NUMBER.lastIndex = i;
    if (NUMBER.exec(t) !== null) {
      i = NUMBER.lastIndex;

      return true;
    }
    expected = 'a value';

    return false;
  };

  try {
    if (value()) {
      space();
      expected = 'the end';
    }
  } catch {
    // nested deeper than the stack goes: said without a place
    return undefined;
  }

  return { at: i, expected };
};

const place = (text: string, at: number) => {
  const before = text.slice(0, at);
  const line = before.split('\n').length;

  return `line ${line}, column ${at - before.lastIndexOf('\n')}`;
};

export const readJsonc = (raw: string): JsoncRead => {
  const { text, unclosed } = blanked(raw);

  if (unclosed !== undefined)
    return { error: `${place(text, unclosed)}: a /* comment is never closed` };
  try {
    const doc: unknown = JSON.parse(text);

    return { doc };
  } catch {
    const first = firstError(text);

    return first === undefined
      ? { error: 'nested too deep to read' }
      : { error: `${place(text, first.at)}: expected ${first.expected}` };
  }
};
