/**
 * Whether a `:` line typed in the Editor is a Neovim Ex command (#346: `Run in Neovim`), as
 * `nvim_parse_cmd` would take it, from the command names Neovim knows (`getcompletion('',
 * 'command')`, sent with the Editor's `:`). A range alone is one (`:42`, `:%`), a range before a
 * command too (`:%s/a/b/g`, `:'<,'>d`); a built-in command is any leading part of its name
 * (Neovim takes `w` for `write`, `s` for `substitute`), a user command (`Lazy`) its whole name or
 * a part only it starts with; a few commands are signs (`:!ls`, `:&&`, `:<`). A line of three words
 * or more with none of Ex's signs is a sentence, though it starts with a name (`make this faster`),
 * and so is two whose first starts `:append`, `:insert` or `:change` (`a question`). Pure.
 */

/** One address of a range: a line, `.`, `$`, a mark, a search, then any offsets. */
const ADDRESS = String.raw`(?:\d+|\.|\$|'[a-zA-Z<>\[\]'"^.]|/(?:[^/\\]|\\.)*/?|\?(?:[^?\\]|\\.)*\??)?(?:\s*[+-]\d*)*`;
const RANGE = new RegExp(String.raw`^(?:%|\*|${ADDRESS}(?:\s*[,;]\s*${ADDRESS})*)`);
/** The commands that are a sign, not a name. */
const SIGNS = new Set(['!', '&', '~', '<', '>', '=', '#', '@', '*']);

/** The line without its leading `:`s and blanks (`::w` is still `w`). */
const bare = (text: string): string => text.replace(/^[\s:]+/, '');

/** Whether `name` names a command among `known`: a built-in by a leading part, a user's whole. */
const names = (name: string, known: readonly string[]): boolean => {
  if (/^[a-z]/.test(name)) return known.some((k) => /^[a-z]/.test(k) && k.startsWith(name));
  const users = known.filter((k) => k.startsWith(name));

  return users.includes(name) || users.length === 1;
};

/** Commands that take lines typed after them: a sentence never starts one (`a question`). */
const TEXT_ENTRY = ['append', 'insert', 'change'];

/**
 * Ex's own signs in a line, which a sentence has not: a pattern or a path (`/`), a pipe, a bang
 * after the name (`w!`) or before a shell command (`!sudo`), the file as `%` or `#` alone. An
 * apostrophe or `50%` is a sentence's.
 */
const signed = (line: string, words: readonly string[]): boolean =>
  /[/|]/.test(line) ||
  /^[A-Za-z]+!/.test(line) ||
  words.some((w) => w === '%' || w === '#' || w.startsWith('!'));

/**
 * Whether a line of words reads as an Ex command rather than a sentence (#346): one word, or a
 * command and its one argument (`e cart.ts`, `set number`), or anything with Ex's signs in it
 * (`s/a b/c d/`); three words or more are a sentence (`make this faster`, `help me read this`).
 */
const commandShaped = (line: string, name: string): boolean => {
  const words = line.split(/\s+/);

  if (words.length === 1 || signed(line, words)) return true;
  // `a question`, `i see`: Neovim would wait for lines to put in
  return words.length === 2 && !TEXT_ENTRY.some((t) => t.startsWith(name));
};

export const isExCommand = (text: string, known: readonly string[]): boolean => {
  const line = bare(text).trimEnd();

  if (line === '') return false;
  const range = RANGE.exec(line)?.[0] ?? '';
  const rest = line.slice(range.length).trimStart();

  // a range alone moves the cursor there (`:42`, `:$`)
  if (rest === '') return range.trim() !== '';
  if (SIGNS.has(rest[0] ?? '')) return true;
  const name = /^[A-Za-z]+/.exec(rest)?.[0];

  // `s/a/b/`, `g/x/d`: the letters run up to the pattern's delimiter
  return name !== undefined && names(name, known) && commandShaped(rest, name);
};
