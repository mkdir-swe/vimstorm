/** The bridge's text field (#314): the caret and the keys of a macOS field, as `ui/field.rs`. */
import { describe, expect, test } from 'bun:test';
import { type Field, caretProp, fieldInsert, fieldKey, fieldOf, withCaret } from './field';

/** `text` with `|` where the caret is, as a Field; and back. */
const at = (marked: string): Field => {
  const i = Array.from(marked).indexOf('|');

  return { text: marked.replace('|', ''), caret: i };
};
const shown = (f: Field | undefined): string | undefined =>
  f === undefined ? undefined : withCaret(f, '|');
const keys = (marked: string, ...ks: string[]): string | undefined => {
  let f: Field | undefined = at(marked);

  for (const k of ks) f = f === undefined ? undefined : fieldKey(f, k);

  return shown(f);
};

describe('a bridge field', () => {
  test('the caret at the end unless kept beside the text; kept within it', () => {
    expect(fieldOf('abc')).toEqual({ text: 'abc', caret: 3 });
    expect(fieldOf('abc', 1)).toEqual({ text: 'abc', caret: 1 });
    expect(fieldOf('abc', 9)).toEqual({ text: 'abc', caret: 3 });
    expect(fieldOf('abc', -1)).toEqual({ text: 'abc', caret: 0 });
    expect(fieldOf('åäö', 2).caret).toBe(2);
  });

  test('← → a character; at either end it stays', () => {
    expect(keys('ab|c', '<Left>')).toBe('a|bc');
    expect(keys('ab|c', '<Right>')).toBe('abc|');
    expect(keys('|abc', '<Left>')).toBe('|abc');
    expect(keys('abc|', '<Right>')).toBe('abc|');
  });

  test('⌥← ⌥→ a word, as macOS: over the gap, then the word', () => {
    expect(keys('fix the cart|', '<M-Left>')).toBe('fix the |cart');
    expect(keys('fix the |cart', '<M-Left>')).toBe('fix |the cart');
    expect(keys('fix the cart  |', '<M-Left>')).toBe('fix the |cart  ');
    expect(keys('|fix the cart', '<M-Right>')).toBe('fix| the cart');
    expect(keys('fix| the cart', '<M-Right>')).toBe('fix the| cart');
    expect(keys('fix #12|', '<M-Left>')).toBe('fix #|12');
  });

  test('⌘← ⌘→ (Home End) the start and the end', () => {
    expect(keys('ab|c', '<D-Left>')).toBe('|abc');
    expect(keys('ab|c', '<D-Right>')).toBe('abc|');
    expect(keys('ab|c', '<Home>')).toBe('|abc');
    expect(keys('a|bc', '<End>')).toBe('abc|');
  });

  test('⌫ the character before the caret, ⌦ the one after; ⌃H is ⌫', () => {
    expect(keys('ab|c', '<BS>')).toBe('a|c');
    expect(keys('|abc', '<BS>')).toBe('|abc');
    expect(keys('ab|c', '<Del>')).toBe('ab|');
    expect(keys('abc|', '<Del>')).toBe('abc|');
    expect(keys('ab|c', '<C-h>')).toBe('a|c');
  });

  test('⌥⌫ the word before, ⌥⌦ the word after; ⌃W is the jump, not the field’s', () => {
    expect(keys('fix the| cart', '<M-BS>')).toBe('fix | cart');
    expect(keys('fix the |cart', '<M-BS>')).toBe('fix |cart');
    expect(keys('fix |the cart', '<M-Del>')).toBe('fix | cart');
    expect(keys('fix the |cart', '<C-w>')).toBeUndefined();
  });

  test('⌘⌫ and ⌃U to the start, the text after the caret kept', () => {
    expect(keys('fix the| cart', '<D-BS>')).toBe('| cart');
    expect(keys('fix the| cart', '<C-u>')).toBe('| cart');
  });

  test('a typed key goes in at the caret; <Space> and <lt> as theirs', () => {
    expect(keys('ab|c', 'x')).toBe('abx|c');
    expect(keys('ab|c', '<Space>')).toBe('ab |c');
    expect(keys('|', '<lt>')).toBe('<|');
    expect(keys('|', 'ö')).toBe('ö|');
  });

  test('a key that is not the field’s is undefined: the screen’s', () => {
    for (const k of ['<CR>', '<Esc>', '<Up>', '<Down>', '<Tab>', '<D-CR>', '<PageDown>'])
      expect(keys('ab|c', k)).toBeUndefined();
  });

  test('pasted text at the caret, the caret after it', () => {
    expect(shown(fieldInsert(at('fix |cart'), 'the '))).toBe('fix the |cart');
  });

  test('characters, not UTF-16 units: an emoji is one step', () => {
    expect(keys('a😀|b', '<Left>')).toBe('a|😀b');
    expect(keys('a😀|b', '<BS>')).toBe('a|b');
  });

  describe('lines (the CommentBox)', () => {
    const lines = (marked: string, k: string) => shown(fieldKey(at(marked), k, { lines: true }));

    test('⌘← ⌘→ the line’s start and end; ⌘⌫ to the line’s start', () => {
      expect(lines('one\ntw|o\nthree', '<D-Left>')).toBe('one\n|two\nthree');
      expect(lines('one\ntw|o\nthree', '<D-Right>')).toBe('one\ntwo|\nthree');
      expect(lines('one\ntw|o\nthree', '<D-BS>')).toBe('one\n|o\nthree');
      expect(lines('one\n|two', '<BS>')).toBe('one|two');
    });

    test('a single-line field’s ⌘← goes to the very start', () => {
      expect(keys('one\ntw|o', '<D-Left>')).toBe('|one\ntwo');
    });
  });

  test('the frame’s caret: absent at the end (frames before #314 read the same)', () => {
    expect(caretProp(at('abc|'))).toBeUndefined();
    expect(caretProp(at('a|bc'))).toBe(1);
  });
});
