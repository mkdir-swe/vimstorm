/**
 * `abe theme` (#108 S4): the themes there are (built-in, yours in `<config>/themes`), one theme's
 * tokens, the look in force (what the shell
 * draws with, `ui bridge`'s `look` effect) and saving changed colours to a theme file of yours. The
 * rules are `core/src/theme/theme.ts`'; the files' IO `ports/src/mac/themes.ts`'.
 */
import { join } from 'node:path';
import {
  changedTokens,
  KEYS_FILE,
  currentTheme,
  findTheme,
  type LookSettings,
  LookStage,
  lookOf,
  type Merged,
  noThemeText,
  planThemeSave,
  readThemeFile,
  readTokenEdits,
  refused,
  SAME_AS_THEME,
  type Theme,
  themeCatalogue,
  themeFileName,
  themeFileText,
  themeGroups,
  type ThemeProblem,
  themeRow,
  yourThemesDir,
  type Handlers,
} from '@abe/core';
import { readText, readThemeFiles, type SettingsPlaces, writeThemeFile } from '@abe/ports';
import { z } from 'zod';
import type { SettingsCtx } from '../layer/settings';

/** Every theme file of yours (`<config>/themes`), read: the themes and the files that do not read. */
export const readThemes = (
  places: SettingsPlaces,
): { catalogue: Theme[]; problems: ThemeProblem[] } => {
  const files: Theme[] = [];
  const problems: ThemeProblem[] = [];

  for (const found of readThemeFiles(yourThemesDir(places.configDir))) {
    const got = readThemeFile(found.text, found.slug, { kind: 'yours', file: found.file });

    if (got.ok) {
      files.push(got.theme);
      if (got.unknown.length > 0)
        problems.push({ file: found.file, message: `no such colour: ${got.unknown.join(', ')}` });
    } else problems.push(got.problem);
  }

  return { catalogue: themeCatalogue(files), problems };
};

const lookSettings = (merged: Merged): LookSettings => ({
  'ui.theme': merged.values['ui.theme'],
  'editor.scheme': merged.values['editor.scheme'],
  'ui.density': merged.values['ui.density'],
  'ui.font.family': merged.values['ui.font.family'],
  'ui.font.size': merged.values['ui.font.size'],
  'ui.font.editorFamily': merged.values['ui.font.editorFamily'],
  'ui.font.editorSize': merged.values['ui.font.editorSize'],
  'ui.font.ligatures': merged.values['ui.font.ligatures'],
});

const noSettings = () =>
  Promise.resolve(refused('no-settings', 'this abe serve was started without its settings'));

/** A `--flag` holding JSON, read with `schema`, or why not. */
const json = <T extends z.ZodType>(
  text: string,
  schema: T,
  what: string,
): { ok: true; value: z.output<T> } | { ok: false; message: string } => {
  let doc: unknown;

  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, message: `${what} is not JSON` };
  }
  const read = schema.safeParse(doc);

  return read.success
    ? { ok: true, value: read.data }
    : { ok: false, message: `${what}: ${z.prettifyError(read.error).replace(/\n/g, '; ')}` };
};

export const themeHandlers = <Ctx extends SettingsCtx>() =>
  ({
    'theme list': (_, ctx) => {
      if (ctx.settings === undefined) return noSettings();
      const merged = ctx.settings.at(ctx.cwd);
      const { catalogue, problems } = readThemes(ctx.settings.places);
      const current = currentTheme(merged.values['ui.theme'], catalogue);

      return Promise.resolve({
        ok: true,
        data: { themes: catalogue.map((t) => themeRow(t, current)), problems },
      });
    },
    'theme show': (args, ctx) => {
      if (ctx.settings === undefined) return noSettings();
      const merged = ctx.settings.at(ctx.cwd);
      const { catalogue } = readThemes(ctx.settings.places);
      const theme = findTheme(catalogue, args.theme);

      if (theme === undefined)
        return Promise.resolve(refused('no-theme', noThemeText(args.theme, catalogue)));

      return Promise.resolve({
        ok: true,
        data: {
          theme: themeRow(theme, currentTheme(merged.values['ui.theme'], catalogue)),
          groups: themeGroups(theme),
        },
      });
    },
    'theme look': (args, ctx) => {
      if (ctx.settings === undefined) return noSettings();
      const merged = ctx.settings.at(ctx.cwd);
      const { catalogue } = readThemes(ctx.settings.places);
      let stage: LookStage | undefined;

      if (args.stage !== undefined) {
        const read = json(args.stage, LookStage, '--stage');

        if (!read.ok) return Promise.resolve(refused('bad-stage', read.message));
        // A stage is a theme picked from the list: one no one has is no stage (#172, #345).
        for (const wanted of [read.value.theme, read.value.scheme])
          if (
            wanted !== undefined &&
            wanted !== SAME_AS_THEME &&
            !catalogue.some((t) => t.slug === wanted)
          )
            return Promise.resolve(
              refused('bad-stage', `--stage: ${noThemeText(wanted, catalogue)}`),
            );
        stage = read.value;
      }

      return Promise.resolve({ ok: true, data: lookOf(lookSettings(merged), catalogue, stage) });
    },
    'theme save': (args, ctx) => {
      if (ctx.settings === undefined) return noSettings();
      const { catalogue } = readThemes(ctx.settings.places);
      const from = findTheme(catalogue, args.theme);

      if (from === undefined)
        return Promise.resolve(
          refused('no-theme', noThemeText(args.theme, catalogue).replace(/;/, ' to change;')),
        );
      const read = readTokenEdits(args.tokens ?? '{}');

      if (!read.ok) return Promise.resolve(refused(read.code, `--tokens: ${read.message}`));
      const planned = planThemeSave(from, read.edits, args.name);

      if (!planned.ok) return Promise.resolve(refused(planned.code, planned.message));
      const { slug, name } = planned.plan;
      // Another theme of yours at that file is never written over unasked (#177).
      const there = catalogue.find((t) => t.source.kind === 'yours' && t.slug === slug);
      const replaced = there === undefined || there === from ? undefined : there;

      if (replaced !== undefined && !args.replace)
        return Promise.resolve(
          refused(
            'theme-exists',
            `${replaced.name} (${slug}) is a theme of yours already (${changedTokens(Object.keys(replaced.changes).length)}): --replace to write over it, or save onto it with abe theme save ${slug}, or --name another name`,
          ),
        );
      const file = join(yourThemesDir(ctx.settings.places.configDir), themeFileName(slug));

      writeThemeFile(file, themeFileText(planned.plan.doc));

      return Promise.resolve({
        ok: true,
        data: {
          slug,
          name,
          file,
          tokens: planned.plan.doc.tokens,
          replaced:
            replaced === undefined
              ? null
              : { name: replaced.name, changed: Object.keys(replaced.changes).length },
        },
      });
    },
  }) satisfies Partial<Handlers<Ctx>>;

/**
 * Watches your theme folder, and your Layer's keys.json (#129: the Feel's keys): a file
 * written, changed or removed is a `settings.changed` naming it (keys none), so the bridge sends
 * the look and the Feel again.
 */
export const startThemeWatch = (o: {
  places: SettingsPlaces;
  emit: (files: string[]) => void;
  every: number;
}): { poll: () => void; stop: () => void } => {
  const keys = join(o.places.configDir, KEYS_FILE);
  const snapshot = () =>
    new Map<string, string | undefined>([
      ...readThemeFiles(yourThemesDir(o.places.configDir)).map((f) => [f.file, f.text] as const),
      [keys, readText(keys)],
    ]);
  let seen = snapshot();
  const poll = () => {
    const now = snapshot();
    const files = [...new Set([...seen.keys(), ...now.keys()])]
      .filter((file) => seen.get(file) !== now.get(file))
      .sort();

    seen = now;
    if (files.length > 0) o.emit(files);
  };
  const timer = setInterval(poll, o.every);

  return {
    poll,
    stop: () => {
      clearInterval(timer);
    },
  };
};
