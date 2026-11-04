/**
 * Theme files on disk (#108 S4): a Layer's `themes/<slug>.json`, listed and read as text, and
 * written by a temporary file renamed over. IO only; what a file means is `core/src/theme/theme.ts`'.
 */
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readText } from './settings';

/** One theme file found: its slug (the file's name), path and text. */
export type ThemeFileText = { slug: string; file: string; text: string };

/** The `*.json` files in `dir`, by name; none when it does not exist. */
export const readThemeFiles = (dir: string): ThemeFileText[] => {
  let names: string[];

  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  return names
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      const file = join(dir, name);
      const text = readText(file);

      return text === undefined ? [] : [{ slug: name.slice(0, -'.json'.length), file, text }];
    });
};

/** Writes a theme file whole, making its folder. */
export const writeThemeFile = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;

  writeFileSync(temp, text);
  renameSync(temp, file);
};
