/**
 * `abe settings import <source>` (#120): another editor's config read from this Mac's listed paths
 * only, as rows (core's mappers), and the ticked ones written to your Layer alone, each as a plain
 * entry; the key bindings' (#129) into your Layer's keys.json, a key → its Keymap action, the
 * keys already there kept. A ticked row the merge refuses (lowering a team's value takes an Override) is not
 * written and is named. A row the picked Feel already gives is not written (#171); a source whose
 * config is not there or does not read writes nothing, not even the Feel (#170), unless `--only`
 * names what to take.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  FEEL_KEYS,
  feelRows,
  type ImportFile,
  type ImportRow,
  type ImportSource,
  type JsoncRead,
  individualFile,
  chordOfText,
  isSettingKey,
  onlyNames,
  onlyRows,
  putEntry,
  readVscode,
  refused,
  type SettingKey,
  unreadableSource,
  activeKeymap,
  JETBRAINS_DIR,
  JETBRAINS_FILES,
  jetbrainsRows,
  KEYS_FILE,
  KeysDoc,
  pickIdeFolder,
  VIM_FILES,
  vimRows,
  VSCODE_FILES,
  vscodeRowsOf,
  type Handlers,
} from '@abe/core';
import { readText, readYamlFile, repoRoot, writeKeysFile, writeYamlFile } from '@abe/ports';
import { loadSettings, type SettingsCtx } from './settings';

/** What a source's files gave: each file as found, and the rows. */
type Read = { files: ImportFile[]; rows: ImportRow[] };

/** A file as found: there or not, and why it does not read. */
const fileOf = (path: string, text: string | undefined, read?: JsoncRead): ImportFile =>
  text === undefined
    ? { path, found: false, error: null }
    : { path, found: true, error: read !== undefined && 'error' in read ? read.error : null };

const readVscodeFiles = (home: string): Read => {
  const settingsPath = join(home, VSCODE_FILES.settings);
  const keysPath = join(home, VSCODE_FILES.keybindings);
  const settings = readText(settingsPath);
  const keybindings = readText(keysPath);
  const read = readVscode({
    ...(settings === undefined ? {} : { settings }),
    ...(keybindings === undefined ? {} : { keybindings }),
  });

  return {
    files: [
      fileOf(settingsPath, settings, read.settings),
      fileOf(keysPath, keybindings, read.keybindings),
    ],
    rows: vscodeRowsOf(read),
  };
};

const listed = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * The newest WebStorm folder's font, scheme, UI / autosave / Project view options and active
 * keymap (`keymaps/<name>.xml`).
 */
const readJetbrainsFiles = (home: string): Read => {
  const root = join(home, JETBRAINS_DIR);
  const ide = pickIdeFolder(listed(root));

  if (ide === undefined)
    return { files: [{ path: root, found: false, error: null }], rows: jetbrainsRows({}) };
  const at = (rel: string) => join(root, ide, rel);
  const options = (['font', 'scheme', 'ui', 'general', 'projectView'] as const).map(
    (k) => [k, at(JETBRAINS_FILES[k]), readText(at(JETBRAINS_FILES[k]))] as const,
  );
  const pick = readText(at(JETBRAINS_FILES.keymapPick));
  // a keymap's name is a file name in keymaps/: never a path out of it
  const named = pick === undefined ? undefined : activeKeymap(pick);
  const name = named === undefined || /[/\\]|\.\./.test(named) ? undefined : named;
  // a built-in keymap (no file of its own) has no changes of yours to bring
  const keymapPath =
    name === undefined ? undefined : at(join(JETBRAINS_FILES.keymaps, `${name}.xml`));
  const keymap = keymapPath === undefined ? undefined : readText(keymapPath);
  // IdeaVim in use: its rc file, else its plugin folder in the IDE's
  const plugin = existsSync(at('plugins/IdeaVIM')) || existsSync(at('plugins/IdeaVim'));
  const rc = existsSync(join(home, '.ideavimrc')) ? '~/.ideavimrc' : undefined;
  const ideavim = rc ?? (plugin ? 'the IdeaVIM plugin' : undefined);

  return {
    files: [
      ...options.map(([, path, text]) => fileOf(path, text)),
      ...(keymapPath === undefined ? [] : [fileOf(keymapPath, keymap)]),
    ],
    rows: jetbrainsRows({
      ide,
      ...Object.fromEntries(
        options.flatMap(([k, , text]) => (text === undefined ? [] : [[k, text]])),
      ),
      ...(keymap === undefined ? {} : { keymap }),
      ...(ideavim === undefined ? {} : { ideavim }),
    }),
  };
};

/** Why a Vim file is left out: VimStorm's own nvim/ (#213, as the Feel loader's #226 rule). */
const OWN_NVIM = "VimStorm's own nvim/ config";

/**
 * Whether `~/.config/nvim` is VimStorm's own `nvim/` (a link to a checkout, for plain `nvim`):
 * the folder it resolves to has VimStorm's app bridge and its colour scheme.
 */
const vimstormOwn = (dir: string): boolean =>
  existsSync(join(dir, 'lua', 'config', 'app.lua')) &&
  existsSync(join(dir, 'colors', 'darcula-contrast.lua'));

const readVimFiles = (home: string): Read => {
  const own = vimstormOwn(join(home, '.config', 'nvim'));
  const left = (f: string) => own && f.startsWith('.config/nvim/');
  const texts = VIM_FILES.map((f) => [f, left(f) ? undefined : readText(join(home, f))] as const);

  return {
    files: texts.map(([f, text]) =>
      left(f) && existsSync(join(home, f))
        ? { path: join(home, f), found: false, error: null, skipped: OWN_NVIM }
        : fileOf(join(home, f), text),
    ),
    rows: vimRows(Object.fromEntries(texts.filter(([, t]) => t !== undefined))),
  };
};

/** keys.json's document: none there is none yet; not a key → action object is `undefined`. */
const keysDocOf = (text: string | undefined): KeysDoc | undefined => {
  if (text === undefined) return {};
  try {
    const read = KeysDoc.safeParse(JSON.parse(text));

    return read.success ? read.data : undefined;
  } catch {
    return undefined;
  }
};

const READERS: Readonly<Record<ImportSource, (home: string) => Read>> = {
  vscode: readVscodeFiles,
  webstorm: readJetbrainsFiles,
  vim: readVimFiles,
};

export const settingsImportHandlers = () =>
  ({
    'settings import': (args, ctx) => {
      if (ctx.settings === undefined)
        return Promise.resolve(
          refused('no-settings', 'this abe serve was started without its settings'),
        );
      const only = args.only === undefined ? undefined : onlyNames(args.only);
      // a setting's key, or `key:<the key>` for a key binding's row (#129)
      const stranger = only?.find(
        (k) => !isSettingKey(k) && !(k.startsWith('key:') && chordOfText(k.slice(4)) !== undefined),
      );

      if (stranger !== undefined)
        return Promise.resolve(
          refused('unknown-setting', `${stranger} is not a setting or key:<a key, like ⌘Y>`),
        );
      const { places } = ctx.settings;
      const read = READERS[args.source](places.home);
      const unreadable = unreadableSource(args.source, read.files);

      // the Feel alone would stand in for what the files say: only what --only names
      if (unreadable !== undefined && only === undefined)
        return Promise.resolve(refused('import-unreadable', `${unreadable}; nothing imported`));
      const named = onlyRows(read.rows, only);
      const file = individualFile(places.configDir);
      const current = readYamlFile(file);

      if ('error' in current)
        return Promise.resolve(refused('bad-layer-file', `${file}: ${current.error}`));

      const repo = repoRoot(resolve(ctx.cwd));
      type Entry = NonNullable<ImportRow['to']>;
      const tickedOf = (list: readonly ImportRow[]) =>
        list.flatMap((r) => (r.ticked && r.to !== null ? [r.to] : []));
      const docOf = (entries: readonly Entry[]) =>
        entries.reduce<unknown>(
          (doc, e) => putEntry(doc, e.key, { kind: 'plain', value: e.value }),
          current.doc,
        );
      const mergedWith = (entries: readonly Entry[]) => {
        const tried = docOf(entries);

        return loadSettings(places, repo, (f) => (f === file ? { doc: tried } : readYamlFile(f)));
      };
      // what is in force without the rows a Feel sets, the Feel picked: is a row the Feel's own?
      const feelKeys = new Set<string>(FEEL_KEYS);
      const without = mergedWith(tickedOf(named).filter((e) => !feelKeys.has(e.key)));
      const rows = feelRows(named, only, (key) => without.values[key]);
      const ticked = tickedOf(rows);
      const merged = mergedWith(ticked);
      const keys = new Set<string>(ticked.map((e) => e.key));
      const refusals = merged.problems
        .filter((p) => p.file === file && p.key !== null && keys.has(p.key))
        .flatMap((p) =>
          p.key !== null && isSettingKey(p.key)
            ? [{ key: p.key, code: p.code, message: p.message }]
            : [],
        );
      const out = new Set<SettingKey>(refusals.map((r) => r.key));
      const kept = ticked.filter((e) => !out.has(e.key));

      // your keys.json (#129): the key bindings' rows go there, a key → its action
      const keysFile = join(places.configDir, KEYS_FILE);
      const keysDoc = keysDocOf(readText(keysFile));
      const binds = rows.flatMap((r) => (r.ticked && r.bind !== null ? [r.bind] : []));

      if (binds.length > 0 && keysDoc === undefined)
        return Promise.resolve(
          refused('bad-keys-file', `${keysFile}: not a JSON object of a key → its action`),
        );
      if (!args.dryRun && kept.length > 0) writeYamlFile(file, docOf(kept));
      if (!args.dryRun && binds.length > 0)
        writeKeysFile(keysFile, {
          ...keysDoc,
          ...Object.fromEntries(binds.map((b) => [b.key, b.action])),
        });
      if (!args.dryRun && kept.length > 0) ctx.settings.poll();

      return Promise.resolve({
        ok: true,
        data: {
          source: args.source,
          files: read.files,
          rows: rows.map((r) => (r.to !== null && out.has(r.to.key) ? { ...r, ticked: false } : r)),
          file,
          dryRun: args.dryRun,
          written: args.dryRun ? [] : kept.map((e) => e.key),
          keysFile,
          keysWritten: args.dryRun ? [] : binds.map((b) => b.key),
          refused: refusals,
        },
      });
    },
  }) satisfies Partial<Handlers<SettingsCtx>>;
