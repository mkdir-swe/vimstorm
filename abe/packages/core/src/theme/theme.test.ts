/** Themes (#108 S4): the tokens' groups, built-ins, theme files over a base, saving, the look. */
import { describe, expect, test } from 'bun:test';
import {
  baseValues,
  builtInThemes,
  groupCounts,
  type LookSettings,
  lookOf,
  planThemeSave,
  readThemeFile,
  resolveTheme,
  themeSlug,
  type Theme,
  type ThemeSource,
  themeCatalogue,
  themeFileText,
  themeGroups,
  themeListText,
  themeRow,
  TOKEN_GROUP_LABELS,
  TOKEN_GROUPS,
  TOKEN_NAMES,
  unknownSchemeProblem,
  unknownThemeProblem,
  SCHEME_GROUPS,
  tokenInfo,
} from './theme';
import { mergeSettings } from '../layer/settings/layers';

const yours = (file = '/c/themes/islands-dark-yours.json') => ({ kind: 'yours' as const, file });

const SETTINGS: LookSettings = {
  'ui.theme': 'islands-dark',
  'editor.scheme': 'theme',
  'ui.density': 'compact',
  'ui.font.family': 'Inter',
  'ui.font.size': 13,
  'ui.font.editorFamily': 'JetBrains Mono',
  'ui.font.editorSize': 13,
  'ui.font.ligatures': false,
};

const read = (
  text: string,
  slug = 'islands-dark-yours',
  source: Exclude<ThemeSource, { kind: 'built-in' }> = yours(),
) => {
  const got = readThemeFile(text, slug, source);

  if (!got.ok) throw new Error(got.problem.message);

  return got;
};

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};

describe('the tokens', () => {
  test("the design system's 260 tokens, in six groups as the Colours editor counts them", () => {
    expect(TOKEN_NAMES).toHaveLength(260);
    expect(new Set(TOKEN_NAMES).size).toBe(260);
    expect(TOKEN_GROUPS.map((g) => TOKEN_GROUP_LABELS[g])).toEqual([
      'Chrome',
      'Editor',
      'Abe status',
      'Git',
      'Diff',
      'Terminal',
    ]);
    expect(groupCounts()).toEqual({
      chrome: 125,
      editor: 71,
      abe: 7,
      git: 17,
      diff: 20,
      terminal: 20,
    });
  });

  test('Abe status holds the seven Abe hues', () => {
    const abe = themeGroups(builtInThemes()[0] ?? fail()).find((g) => g.group === 'abe');

    expect(abe?.tokens.map((t) => t.name)).toEqual([
      'abe-good',
      'abe-bad',
      'abe-warn',
      'abe-needs-you',
      'abe-accent',
      'abe-person',
      'abe-path',
    ]);
  });
});

const fail = (): never => {
  throw new Error('no theme');
};

describe('the built-in themes', () => {
  test('Islands Dark is the design system: every token a colour, aliases followed', () => {
    const dark = resolveTheme({ base: 'islands-dark', changes: {} });

    expect(dark['frame-bg']).toBe('#26282b');
    expect(dark['abe-needs-you']).toBe('#5ec8c0');
    // `{popup-bg}`
    expect(dark['popup-header-bg']).toBe(dark['popup-bg']);
    for (const name of TOKEN_NAMES) expect(dark[name]).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
  });

  test('Islands Light is light: grounds near white, text dark, every token a colour', () => {
    const light = resolveTheme({ base: 'islands-light', changes: {} });

    for (const name of TOKEN_NAMES) expect(light[name]).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
    for (const ground of ['frame-bg', 'panel-bg', 'editor-bg', 'popup-bg'] as const)
      expect(luminance(light[ground])).toBeGreaterThan(0.85);
    for (const text of ['text', 'editor-fg', 'selection-text'] as const)
      expect(luminance(light[text])).toBeLessThan(0.3);
  });
});

describe('slugs', () => {
  test.each([
    ['Islands Dark (yours)', 'islands-dark-yours'],
    ['Islands Dark warm', 'islands-dark-warm'],
    ['  Café  Nöir!! ', 'cafe-noir'],
    ['team/demo: 2', 'team-demo-2'],
  ])('%s → %s', (name, slug) => {
    expect(themeSlug(name)).toBe(slug);
  });
});

describe('theme files', () => {
  test('only the tokens a file changes; an alias follows a changed token', () => {
    const { theme } = read(
      JSON.stringify({
        name: 'Islands Dark (yours)',
        base: 'islands-dark',
        tokens: { 'abe-needs-you': '#A979F7', 'popup-bg': '#303030' },
      }),
    );
    const colours = resolveTheme(theme);

    expect(theme.changes).toEqual({ 'abe-needs-you': '#a979f7', 'popup-bg': '#303030' });
    expect(colours['abe-needs-you']).toBe('#a979f7');
    expect(colours['popup-header-bg']).toBe('#303030');
    expect(colours['frame-bg']).toBe(baseValues('islands-dark')['frame-bg']);
  });

  test('a token this build does not know is passed over and named', () => {
    const got = read(
      JSON.stringify({ name: 'X', base: 'islands-light', tokens: { 'no-such': '#000000' } }),
      'x',
    );

    expect(got.theme.changes).toEqual({});
    expect(got.unknown).toEqual(['no-such']);
  });

  test.each([
    ['not json', 'islands-x', 'not JSON'],
    [JSON.stringify({ name: 'X', base: 'solarized', tokens: {} }), 'x', 'base'],
    [JSON.stringify({ name: 'X', base: 'islands-dark', tokens: { text: 'red' } }), 'x', 'a colour'],
    [JSON.stringify({ name: 'X', base: 'islands-dark', tokens: {} }), 'islands-dark', 'built-in'],
    [JSON.stringify({ name: 'X', base: 'islands-dark', tokens: {} }), 'My Theme', 'my-theme.json'],
  ])('a file that does not read says why (%s)', (text, slug, why) => {
    const got = readThemeFile(text, slug, yours(`/c/themes/${slug}.json`));

    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.problem.message).toContain(why);
  });

  test('the catalogue: built-ins, then yours by name; a slug taken is passed over', () => {
    const file = (slug: string, source: Theme['source']): Theme => ({
      slug,
      name: slug,
      base: 'islands-dark',
      source,
      changes: {},
    });
    const all = themeCatalogue([
      file('warm', yours('/c/themes/warm.json')),
      file('mine', yours('/c/themes/mine.json')),
      file('islands-dark', yours('/c/themes/islands-dark.json')),
    ]);

    expect(all.map((t) => `${t.slug}:${t.source.kind}`)).toEqual([
      'islands-dark:built-in',
      'islands-light:built-in',
      'dark-modern:built-in',
      'mine:yours',
      'warm:yours',
    ]);
  });
});

describe('saving a theme', () => {
  const dark = builtInThemes()[0] ?? fail();

  test('a change to a built-in saves <Base> (yours), only the changed token', () => {
    const got = planThemeSave(dark, { 'abe-needs-you': '#a979f7' });

    expect(got).toEqual({
      ok: true,
      plan: {
        slug: 'islands-dark-yours',
        name: 'Islands Dark (yours)',
        doc: {
          name: 'Islands Dark (yours)',
          base: 'islands-dark',
          tokens: { 'abe-needs-you': '#a979f7' },
        },
      },
    });
  });

  test('a built-in is never written, whatever the name', () => {
    expect(planThemeSave(dark, {}, 'Islands Light')).toMatchObject({
      ok: false,
      code: 'built-in-theme',
    });
  });

  test('your own theme is written in place; a colour back at the base drops its token (⌫)', () => {
    const { theme } = read(
      JSON.stringify({
        name: 'Islands Dark (yours)',
        base: 'islands-dark',
        tokens: { 'abe-needs-you': '#a979f7', text: '#ffffff' },
      }),
    );
    const got = planThemeSave(theme, {
      text: baseValues('islands-dark').text,
      'abe-good': '#00ff00',
    });

    expect(got.ok && got.plan.slug).toBe('islands-dark-yours');
    expect(got.ok && got.plan.doc.tokens).toEqual({
      'abe-good': '#00ff00',
      'abe-needs-you': '#a979f7',
    });
  });

  test('the file is two-space JSON', () => {
    expect(themeFileText({ name: 'A', base: 'islands-dark', tokens: { text: '#ffffff' } })).toBe(
      '{\n  "name": "A",\n  "base": "islands-dark",\n  "tokens": {\n    "text": "#ffffff"\n  }\n}\n',
    );
  });
});

describe('the look', () => {
  const catalogue = themeCatalogue([
    read(
      JSON.stringify({
        name: 'Islands Dark (yours)',
        base: 'islands-dark',
        tokens: { 'abe-needs-you': '#a979f7' },
      }),
    ).theme,
  ]);

  test("the settings' theme, density and fonts", () => {
    const look = lookOf(
      { ...SETTINGS, 'ui.theme': 'islands-light', 'ui.density': 'default' },
      catalogue,
    );

    expect(look.theme).toEqual({
      slug: 'islands-light',
      name: 'Islands Light',
      dark: false,
      syntax: 'darcula',
    });
    expect(look.tokens['frame-bg']).toBe(baseValues('islands-light')['frame-bg']);
    expect(Object.keys(look.tokens)).toHaveLength(260);
    expect(look.density).toBe('default');
    expect(look.font).toEqual({
      family: 'Inter',
      size: 13,
      editorFamily: 'JetBrains Mono',
      editorSize: 13,
      ligatures: false,
    });
    expect(look.staged).toBe(false);
  });

  // #129: the syntax colours follow VS Code's capture mapping under Dark Modern, and a theme of
  // yours over it keeps that
  test("Dark Modern's syntax mapping is VS Code's, a theme over it too", () => {
    const all = themeCatalogue([
      read(
        themeFileText({ name: 'Dark Modern (yours)', base: 'dark-modern', tokens: {} }),
        'dark-modern-yours',
      ).theme,
    ]);

    expect(lookOf({ ...SETTINGS, 'ui.theme': 'dark-modern' }, all).theme.syntax).toBe('vscode');
    expect(lookOf({ ...SETTINGS, 'ui.theme': 'dark-modern-yours' }, all).theme.syntax).toBe(
      'vscode',
    );
    expect(lookOf(SETTINGS, all).theme.syntax).toBe('darcula');
  });

  test('a theme file of yours', () => {
    expect(
      lookOf({ ...SETTINGS, 'ui.theme': 'islands-dark-yours' }, catalogue).tokens['abe-needs-you'],
    ).toBe('#a979f7');
  });

  test('a theme no one has is Islands Dark', () => {
    expect(lookOf({ ...SETTINGS, 'ui.theme': 'gone' }, catalogue).theme.slug).toBe('islands-dark');
  });

  test('a stage over it: another theme, density, a font, colours being edited', () => {
    const look = lookOf(SETTINGS, catalogue, {
      theme: 'islands-dark-yours',
      density: 'default',
      font: { editorSize: 15 },
      tokens: { 'abe-bad': '#ff0000' },
    });

    expect(look.theme.slug).toBe('islands-dark-yours');
    expect(look.tokens['abe-needs-you']).toBe('#a979f7');
    expect(look.tokens['abe-bad']).toBe('#ff0000');
    expect(look.density).toBe('default');
    expect(look.font.editorSize).toBe(15);
    expect(look.font.family).toBe('Inter');
    expect(look.staged).toBe(true);
  });
});

describe('the editor scheme (#345): the theme’s own, or a named one that a theme switch leaves alone', () => {
  const catalogue = themeCatalogue([]);
  const light = baseValues('islands-light');
  const dark = baseValues('islands-dark');

  test('Same as theme: the theme’s every colour, nvim’s background and mapping the theme’s', () => {
    const look = lookOf({ ...SETTINGS, 'ui.theme': 'islands-light' }, catalogue);

    expect(look.scheme).toEqual({
      slug: 'islands-light',
      name: 'Islands Light',
      dark: false,
      syntax: 'darcula',
      follows: true,
    });
    expect(look.tokens).toEqual(light);
  });

  test('a named scheme: its editor, git, diff and terminal colours over the theme’s chrome', () => {
    const look = lookOf(
      { ...SETTINGS, 'ui.theme': 'islands-light', 'editor.scheme': 'islands-dark' },
      catalogue,
    );

    expect(look.theme).toMatchObject({ slug: 'islands-light', dark: false });
    expect(look.scheme).toMatchObject({ slug: 'islands-dark', dark: true, follows: false });
    expect(look.tokens['editor-bg']).toBe(dark['editor-bg']);
    expect(look.tokens['syntax-keyword']).toBe(dark['syntax-keyword']);
    expect(look.tokens['term-red']).toBe(dark['term-red']);
    expect(look.tokens['frame-bg']).toBe(light['frame-bg']);
    expect(look.tokens['abe-accent']).toBe(light['abe-accent']);
    for (const name of TOKEN_NAMES)
      expect({ name, hex: look.tokens[name] }).toEqual({
        name,
        hex: SCHEME_GROUPS.includes(tokenInfo(name).group) ? dark[name] : light[name],
      });
  });

  test('a theme switch leaves a named scheme alone; a stage picks either', () => {
    const named = { ...SETTINGS, 'editor.scheme': 'dark-modern' };

    for (const theme of ['islands-dark', 'islands-light'])
      expect(lookOf({ ...named, 'ui.theme': theme }, catalogue).scheme).toMatchObject({
        slug: 'dark-modern',
        syntax: 'vscode',
      });
    expect(lookOf(SETTINGS, catalogue, { scheme: 'islands-light' }).scheme.slug).toBe(
      'islands-light',
    );
    expect(lookOf(named, catalogue, { scheme: 'theme' }).scheme).toMatchObject({
      slug: 'islands-dark',
      follows: true,
    });
  });

  test('a scheme no one has is the theme’s own, and a Layer’s problem', () => {
    const mine = mergeSettings([
      { place: 'machine', file: '/me/settings.yaml', doc: { editor: { scheme: 'gone' } } },
    ]);

    expect(lookOf({ ...SETTINGS, 'editor.scheme': 'gone' }, catalogue).scheme).toMatchObject({
      slug: 'islands-dark',
      follows: true,
    });
    expect(unknownSchemeProblem(mine, catalogue)).toMatchObject({
      code: 'unknown-scheme',
      key: 'editor.scheme',
      layer: 'individual',
    });
    expect(unknownSchemeProblem(mergeSettings([]), catalogue)).toBeUndefined();
  });

  test('a theme file may not take the scheme’s word for the theme’s own', () => {
    const got = readThemeFile(
      themeFileText({ name: 'Theme', base: 'islands-dark', tokens: {} }),
      'theme',
      yours('/c/themes/theme.json'),
    );

    expect(got.ok).toBe(false);
  });
});

describe('a ui.theme no theme has (#172)', () => {
  const mine = (theme: string) =>
    mergeSettings([{ place: 'machine', file: '/me/settings.yaml', doc: { ui: { theme } } }]);
  const catalogue = themeCatalogue([]);

  test('a problem of the Layer that wrote it: the slug, what is drawn, the themes there are', () => {
    expect(unknownThemeProblem(mine('no-such-theme'), catalogue)).toEqual({
      code: 'unknown-theme',
      layer: 'individual',
      file: '/me/settings.yaml',
      key: 'ui.theme',
      message:
        'no theme no-such-theme, so Islands Dark is drawn; the themes: islands-dark, islands-light, dark-modern',
    });
  });

  test('a theme there is, and the built-in default, are none', () => {
    expect(unknownThemeProblem(mine('islands-light'), catalogue)).toBeUndefined();
    expect(unknownThemeProblem(mergeSettings([]), catalogue)).toBeUndefined();
  });
});

describe('the text', () => {
  test('list: each theme, its slug beside it (#177), its source, the current one', () => {
    const themes = themeCatalogue([]).map((t) => themeRow(t, 'islands-dark'));

    expect(
      themeListText({ themes, problems: [{ file: '/c/themes/x.json', message: 'not JSON' }] }),
    ).toBe(
      'Islands Dark   islands-dark   built-in · current\nIslands Light  islands-light  built-in\nDark Modern    dark-modern    built-in\n⚠ /c/themes/x.json: not JSON\n',
    );
  });
});
