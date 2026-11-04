/**
 * The bridge's text field (#314): what is typed and where the caret is, and the keys of a macOS
 * field on it, the app's own field's (`app/src/ui/field.rs`): ← → a character, ⌥← ⌥→ a word,
 * ⌘← ⌘→ (Home End) the start and the end, ⌫ ⌦ a character, ⌥⌫ ⌥⌦ a word, ⌘⌫ (⌃U) to the
 * start. No selection. Every field the bridge draws keeps one: Command mode's filter and prompt,
 * a pick's filter, the CommentBox, Chat's composer, a question card's own answer, the Override
 * reason, the `/` filters. A frame carries the caret as `caret` (absent: at the text's end); Rust draws it there.
 *
 * The caret counts characters (code points, as `Array.from`), so an emoji is one step.
 */

/** A field's text and its caret (0 … the text's length in characters). */
export type Field = { readonly text: string; readonly caret: number };

/** How a field takes its keys: `lines` (the CommentBox): ⌘← ⌘→ ⌘⌫ stop at the line's ends. */
export type FieldOptions = { lines?: boolean | undefined };

const chars = (text: string): string[] => Array.from(text);

/** The field of `text`, the caret kept beside it (absent: at the end; kept within the text). */
export const fieldOf = (text: string, caret?: number): Field => {
  const n = chars(text).length;

  return { text, caret: caret === undefined ? n : Math.min(n, Math.max(0, Math.trunc(caret))) };
};

/** What a key types: one character (`<Space>`, `<lt>` as theirs); a named key none. */
export const typedChar = (key: string): string | undefined => {
  if (key === '<Space>') return ' ';
  if (key === '<lt>') return '<';

  return chars(key).length === 1 ? key : undefined;
};

/** A word's character, as the app's field (`is_word`): a letter (its marks too), a digit, `_`. */
const isWord = (c: string | undefined): boolean =>
  c !== undefined && /^[\p{L}\p{M}\p{N}_]$/u.test(c);

/** The start of the word before `at`: over the gap, then the word (macOS ⌥←). */
const prevWord = (cs: readonly string[], at: number): number => {
  let i = at;

  while (i > 0 && !isWord(cs[i - 1])) i -= 1;
  while (i > 0 && isWord(cs[i - 1])) i -= 1;

  return i;
};

/** The end of the word after `at` (macOS ⌥→). */
const nextWord = (cs: readonly string[], at: number): number => {
  let i = at;

  while (i < cs.length && !isWord(cs[i])) i += 1;
  while (i < cs.length && isWord(cs[i])) i += 1;

  return i;
};

/** The start of the caret's line (`lines`), else of the text. */
const lineStart = (cs: readonly string[], at: number, lines: boolean): number => {
  if (!lines) return 0;
  let i = at;

  while (i > 0 && cs[i - 1] !== '\n') i -= 1;

  return i;
};

/** The end of the caret's line (`lines`), else of the text. */
const lineEnd = (cs: readonly string[], at: number, lines: boolean): number => {
  if (!lines) return cs.length;
  let i = at;

  while (i < cs.length && cs[i] !== '\n') i += 1;

  return i;
};

/** The field with the characters between `a` and `b` gone, the caret where they were. */
const cut = (cs: readonly string[], a: number, b: number): Field => {
  const [from, to] = a <= b ? [a, b] : [b, a];

  return { text: [...cs.slice(0, from), ...cs.slice(to)].join(''), caret: from };
};

/** Text typed or pasted at the caret, the caret after it. */
export const fieldInsert = (f: Field, text: string): Field => {
  const cs = chars(f.text);

  return {
    text: [...cs.slice(0, f.caret), text, ...cs.slice(f.caret)].join(''),
    caret: f.caret + chars(text).length,
  };
};

/**
 * A key on the field: the field after it (moved, edited, typed into), or undefined when the key
 * is not the field's (⏎, Esc, ↑ ↓, Tab …: the screen's).
 */
export const fieldKey = (f: Field, key: string, options: FieldOptions = {}): Field | undefined => {
  const cs = chars(f.text);
  const c = Math.min(cs.length, Math.max(0, f.caret));
  const lines = options.lines === true;
  const to = (caret: number): Field => ({ text: f.text, caret });

  switch (key) {
    case '<Left>':
      return to(Math.max(0, c - 1));
    case '<Right>':
      return to(Math.min(cs.length, c + 1));
    case '<M-Left>':
      return to(prevWord(cs, c));
    case '<M-Right>':
      return to(nextWord(cs, c));
    case '<D-Left>':
    case '<Home>':
      return to(lineStart(cs, c, lines));
    case '<D-Right>':
    case '<End>':
      return to(lineEnd(cs, c, lines));
    case '<BS>':
    case '<C-h>':
      return cut(cs, Math.max(0, c - 1), c);
    case '<Del>':
      return cut(cs, c, Math.min(cs.length, c + 1));
    case '<M-BS>':
      return cut(cs, prevWord(cs, c), c);
    case '<M-Del>':
      return cut(cs, c, nextWord(cs, c));
    case '<D-BS>':
    case '<C-u>':
      return cut(cs, lineStart(cs, c, lines), c);
  }
  const ch = typedChar(key);

  return ch === undefined ? undefined : fieldInsert({ text: f.text, caret: c }, ch);
};

/** A frame's `caret` prop, spread into its props: none when the state keeps none (at the end). */
export const caretOf = (caret: number | undefined): { caret?: number } =>
  caret === undefined ? {} : { caret };

/** The caret for a frame: absent at the text's end, so frames from before #314 read the same. */
export const caretProp = (f: Field): number | undefined =>
  f.caret >= chars(f.text).length ? undefined : f.caret;

/** The text with `glyph` where the caret is: a header note's `/` filter (`/ca▏rt`). */
export const withCaret = (f: Field, glyph = '▏'): string => {
  const cs = chars(f.text);

  return [...cs.slice(0, f.caret), glyph, ...cs.slice(f.caret)].join('');
};
