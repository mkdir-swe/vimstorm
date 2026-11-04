/**
 * Abe's blocks in a repository's `info/exclude`, each between its own marker lines, so each is
 * written and taken out whole and leaves every other line (the person's, another block) as it is.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** `was`: the start lines an earlier Abe wrote the block with, read as its start too. */
export type ExcludeBlock = { start: string; end: string; was?: readonly string[] };

/** The install's: what it keeps out of git (local, and yours for the repo either kind). */
export const INSTALL_EXCLUDE: ExcludeBlock = {
  start: '# abe install: kept out of git',
  end: '# abe install: end',
  was: ['# abe install: Just this Mac (kept out of git)'],
};

/** Where `block` starts in `lines`: its start line, or one an earlier Abe wrote; -1: none. */
export const startOf = (lines: readonly string[], block: ExcludeBlock): number =>
  [block.start, ...(block.was ?? [])].map((s) => lines.indexOf(s)).find((i) => i >= 0) ?? -1;

/**
 * A card worktree's: its evidence folder, and the files a PR checkout gets copied from the main
 * checkout, while one of Abe's worktrees is there.
 */
export const CARD_EXCLUDE: ExcludeBlock = {
  start: '# abe: card worktrees (kept out of git)',
  end: '# abe: card worktrees end',
};

/** `text` without `block`, then with `paths` in it (none: no block). */
export const blockText = (text: string, block: ExcludeBlock, paths: readonly string[]): string => {
  const lines = text.split('\n');
  const start = startOf(lines, block);
  const end = lines.indexOf(block.end, start);
  const rest = start < 0 || end < 0 ? lines : [...lines.slice(0, start), ...lines.slice(end + 1)];
  const kept = rest.join('\n').replace(/\n+$/, '');
  const before = kept === '' ? '' : `${kept}\n`;

  return paths.length === 0
    ? before
    : `${before}${[block.start, ...paths, block.end].join('\n')}\n`;
};

/** The lines `block` holds in `text`. */
const blockLines = (text: string, block: ExcludeBlock): string[] => {
  const lines = text.split('\n');
  const start = startOf(lines, block);
  const end = lines.indexOf(block.end, start);

  return start < 0 || end < 0 ? [] : lines.slice(start + 1, end);
};

/**
 * The file at `file` with `paths` added to `block`, each once and none the file has outside it
 * (the person's own line stays theirs); written only when it changed.
 */
export const addToBlock = (file: string, block: ExcludeBlock, paths: readonly string[]): void => {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const held = blockLines(text, block);
  const outside = new Set(blockText(text, block, []).split('\n'));

  writeBlock(file, block, [...new Set([...held, ...paths.filter((p) => !outside.has(p))])]);
};

/** The file at `file` with `block` holding `paths` (none: taken out); written only when it changed. */
export const writeBlock = (file: string, block: ExcludeBlock, paths: readonly string[]): void => {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const next = blockText(text, block, paths);

  if (next === text) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
};

/**
 * `paths` kept out of git in the main checkout `top` (its `.git` a folder), in the install's
 * block: yours for this repo (ADR 0030) whatever the install's kind. Nothing when `top` has no
 * `.git` folder.
 */
export const excludeInstalled = (top: string, paths: readonly string[]): void => {
  const git = join(top, '.git');

  if (!existsSync(git) || !statSync(git).isDirectory()) return;
  addToBlock(join(git, 'info', 'exclude'), INSTALL_EXCLUDE, paths);
};
