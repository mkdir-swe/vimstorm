/**
 * A source whose config is not there or does not read (#170): its import writes nothing, not even
 * the Feel, since the person would get the Feel's bundle in place of what their files say.
 */
import { type ImportFile, type ImportSource } from './contract';
import { JETBRAINS_DIR } from './jetbrains';
import { VSCODE_FILES } from './vscode';

const said = (f: ImportFile) =>
  f.error !== null ? `${f.path} does not read: ${f.error}` : `${f.path} not found`;

/** Why `source`'s files give nothing to import, or none: they do. */
export const unreadableSource = (
  source: ImportSource,
  files: readonly ImportFile[],
): string | undefined => {
  if (source === 'vscode') {
    const settings = files.find((f) => f.path.endsWith(VSCODE_FILES.settings));

    return settings === undefined || (settings.found && settings.error === null)
      ? undefined
      : said(settings);
  }
  if (source === 'webstorm') {
    // no IDE folder: the JetBrains root is the one file listed
    const root = files.find((f) => f.path.endsWith(JETBRAINS_DIR) && !f.found);

    return root === undefined ? undefined : `${root.path}: no JetBrains IDE config there`;
  }

  return files.some((f) => f.found)
    ? undefined
    : `none of ${files.map((f) => f.path).join(', ')} found`;
};
