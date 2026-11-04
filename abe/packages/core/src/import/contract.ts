/** Imported config (#120): what a source would bring, as rows, and `abe settings import`'s result. */
import { z } from 'zod';
import { KeymapActionName } from '../theme/keymap';
import { SettingKeyName } from '../layer/settings/keys';
import { SettingValue } from '../layer/settings/contract';
import { clip } from './rows';

/** Where the config comes from: VS Code, a JetBrains IDE (WebStorm), Vim / Neovim. */
export const IMPORT_SOURCES = ['vscode', 'webstorm', 'vim'] as const;
export const ImportSource = z.enum(IMPORT_SOURCES);
export type ImportSource = z.infer<typeof ImportSource>;

/**
 * One thing the source has: its own words (`from`), and the setting it becomes here (`to`), or
 * none (`no match here`, never ticked). A ticked row is what OK (or the import) writes.
 */
export const ImportRow = z.strictObject({
  /** The source's own name for it: a setting (`editor.fontSize`), `keys:<chord>`, `feel`. */
  id: z.string().min(1),
  group: z.enum(['feel', 'settings', 'keys', 'theme']),
  /** As the source writes it: `editor.fontSize: 14`. */
  from: z.string(),
  to: z.strictObject({ key: SettingKeyName, value: SettingValue }).nullable(),
  /** A key binding's match (#129): your key (`⌘Y`) and the Keymap action it does, for keys.json. */
  bind: z.strictObject({ key: z.string().min(1), action: KeymapActionName }).nullable(),
  /** Why there is no match, or what a near match leaves out. */
  note: z.string().nullable(),
  ticked: z.boolean(),
});
export type ImportRow = z.infer<typeof ImportRow>;

/** A file the source reads, and whether it was there. */
export const ImportFile = z.strictObject({
  path: z.string(),
  found: z.boolean(),
  /** It is there but does not read (`not JSON: …`). */
  error: z.string().nullable(),
  /** Left out on purpose, and why: VimStorm's own nvim/ config is no other editor's (#213). */
  skipped: z.string().optional(),
});
export type ImportFile = z.infer<typeof ImportFile>;

export const SettingsImportData = z.strictObject({
  source: ImportSource,
  files: z.array(ImportFile),
  rows: z.array(ImportRow),
  /** Your Layer's file, written (or that would be, with --dry-run). */
  file: z.string(),
  dryRun: z.boolean(),
  /** The keys written to your Layer (none with --dry-run). */
  written: z.array(SettingKeyName),
  /** Your Layer's keys.json, and the keys written to it (#129; none with --dry-run). */
  keysFile: z.string(),
  keysWritten: z.array(z.string()),
  /** Ticked rows the merge refused (`override-required`, …): not written. */
  refused: z.array(z.strictObject({ key: SettingKeyName, code: z.string(), message: z.string() })),
});
export type SettingsImportData = z.infer<typeof SettingsImportData>;

/** A value as a row shows it, cut where long (a 30 MB font name is not echoed). */
const shown = (v: unknown) => clip(typeof v === 'string' ? v : JSON.stringify(v));

const fileState = (f: ImportFile) => {
  if (f.error !== null) return `does not read: ${f.error}`;
  if (f.skipped !== undefined) return `left out: ${f.skipped}`;

  return f.found ? 'read' : 'not found';
};

/** `abe settings import`'s text: the files, each row (`✓` ticked, `·` not), then what happened. */
export const settingsImportText = (d: SettingsImportData): string => {
  const files = d.files.map((f) => `${f.path}  ${fileState(f)}\n`);
  const toOf = (r: ImportRow) => {
    const note = r.note === null ? '' : `  (${r.note})`;

    if (r.to !== null) return `${r.to.key} = ${shown(r.to.value)}${note}`;
    if (r.bind !== null) return `${r.bind.key} = ${r.bind.action}${note}`;

    return r.note ?? 'no match here';
  };
  const rows = d.rows.map((r) => {
    const to = toOf(r);

    return `${r.ticked ? '✓' : '·'} ${r.from}  →  ${to}\n`;
  });
  const refused = d.refused.map((r) => `! ${r.key}: ${r.code}: ${r.message}\n`);
  const ticked = d.rows.filter((r) => r.ticked && r.to !== null).length;
  const keys = d.rows.filter((r) => r.ticked && r.bind !== null).length;
  const end = d.dryRun
    ? `dry run: ${ticked} would be written to ${d.file}\n`
    : `${d.written.length} written to ${d.file}\n`;
  const keysEnd =
    keys === 0
      ? []
      : [
          d.dryRun
            ? `dry run: ${keys} ${keys === 1 ? 'key' : 'keys'} would be written to ${d.keysFile}\n`
            : `${d.keysWritten.length} ${d.keysWritten.length === 1 ? 'key' : 'keys'} written to ${d.keysFile}\n`,
        ];

  return [...files, ...rows, ...refused, end, ...keysEnd].join('');
};
