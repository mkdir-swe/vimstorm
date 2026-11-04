/**
 * `abe theme` (#108 S4) in process on real folders: the themes listed from your folder, one shown, the look in force with a stage over it, a save that writes only yours and
 * never a built-in, and the watch that makes a theme file's change a `settings.changed`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { themeListText, themeSaveText } from '@abe/core';
import { type SettingsService, startSettings } from '../layer/settings';
import { startThemeWatch, themeHandlers } from './theme';

let root: string;
let settings: SettingsService;
const handlers = themeHandlers();

const write = (path: string, text: string) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
};

const theme = (name: string, base: string, tokens: Record<string, string>) =>
  JSON.stringify({ name, base, tokens });

const ctx = () => ({ cwd: join(root, 'repo'), settings });

const ok = <T>(
  got: { ok: true; data: T } | { ok: false; error: { code: string; message: string } },
): T => {
  if (!got.ok) throw new Error(`${got.error.code}: ${got.error.message}`);

  return got.data;
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-theme-')));
  write('mine/settings.yaml', 'ui.theme: islands-dark-yours\n');
  write(
    'mine/themes/islands-dark-yours.json',
    theme('Islands Dark (yours)', 'islands-dark', { 'abe-needs-you': '#a979f7' }),
  );
  write('mine/themes/broken.json', '{');
  write(
    'mine/themes/islands-dark-warm.json',
    theme('Islands Dark warm', 'islands-dark', { 'frame-bg': '#2b2722' }),
  );
  mkdirSync(join(root, 'repo', '.git'), { recursive: true });
  settings = startSettings({
    places: { configDir: join(root, 'mine'), home: root },
    emit: () => undefined,
    every: 3_600_000,
  });
});

afterEach(() => {
  settings.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('theme list', () => {
  test('the built-ins, then yours; the current one; a file that does not read', async () => {
    const data = ok(await handlers['theme list']({}, ctx()));

    expect(data.themes.map((t) => [t.slug, t.source.kind, t.current, t.changed])).toEqual([
      ['islands-dark', 'built-in', false, 0],
      ['islands-light', 'built-in', false, 0],
      ['dark-modern', 'built-in', false, 0],
      ['islands-dark-yours', 'yours', true, 1],
      ['islands-dark-warm', 'yours', false, 1],
    ]);
    expect(data.themes[4]?.source).toEqual({
      kind: 'yours',
      file: join(root, 'mine/themes/islands-dark-warm.json'),
    });
    expect(data.problems).toEqual([
      { file: join(root, 'mine/themes/broken.json'), message: 'not JSON' },
    ]);
  });
});

describe('theme show', () => {
  test('every token by group, the changed one with what it was', async () => {
    const data = ok(await handlers['theme show']({ theme: 'islands-dark-yours' }, ctx()));
    const abe = data.groups.find((g) => g.group === 'abe');

    expect(data.groups.map((g) => [g.label, g.count, g.changed])).toEqual([
      ['Chrome', 125, 0],
      ['Editor', 71, 0],
      ['Abe status', 7, 1],
      ['Git', 17, 0],
      ['Diff', 20, 0],
      ['Terminal', 20, 0],
    ]);
    expect(abe?.tokens.find((t) => t.name === 'abe-needs-you')).toMatchObject({
      value: '#a979f7',
      was: '#5ec8c0',
    });
  });

  test('a theme no one has', async () => {
    expect(await handlers['theme show']({ theme: 'nope' }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'no-theme' },
    });
  });

  test('the list shows each slug beside its name (#177)', async () => {
    const text = themeListText(ok(await handlers['theme list']({}, ctx())));

    expect(text).toContain('Islands Dark          islands-dark        built-in\n');
    expect(text).toContain(
      'Islands Dark (yours)  islands-dark-yours  yours · current · 1 changed over Islands Dark\n',
    );
  });
});

describe('theme look', () => {
  test('the settings in force, with a stage over them', async () => {
    const plain = ok(await handlers['theme look']({}, ctx()));

    expect(plain.theme.slug).toBe('islands-dark-yours');
    expect(plain.tokens['abe-needs-you']).toBe('#a979f7');
    expect(plain.staged).toBe(false);

    const staged = ok(
      await handlers['theme look'](
        { stage: JSON.stringify({ theme: 'islands-light', density: 'default' }) },
        ctx(),
      ),
    );

    expect(staged).toMatchObject({
      theme: { slug: 'islands-light', dark: false },
      density: 'default',
      staged: true,
    });
  });

  test('a stage naming a theme no one has is refused, with the themes there are (#172)', async () => {
    expect(
      await handlers['theme look']({ stage: JSON.stringify({ theme: 'nope' }) }, ctx()),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'bad-stage',
        message:
          '--stage: no theme nope; the themes: islands-dark, islands-light, dark-modern, islands-dark-yours, islands-dark-warm',
      },
    });
  });

  test('a stage that does not read is refused', async () => {
    expect(await handlers['theme look']({ stage: '{"density": "roomy"}' }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'bad-stage' },
    });
  });
});

describe('theme save', () => {
  test('a built-in changed saves <Base> (yours) with only that token', async () => {
    rmSync(join(root, 'mine/themes/islands-dark-yours.json'));
    const data = ok(
      await handlers['theme save'](
        { theme: 'islands-dark', tokens: '{"abe-needs-you": "#A979F7"}', replace: false },
        ctx(),
      ),
    );
    const file = join(root, 'mine/themes/islands-dark-yours.json');

    expect(data).toEqual({
      slug: 'islands-dark-yours',
      name: 'Islands Dark (yours)',
      file,
      tokens: { 'abe-needs-you': '#a979f7' },
      replaced: null,
    });
    expect(themeSaveText(data)).toBe(
      `saved Islands Dark (yours) (islands-dark-yours) to ${file}: 1 changed token\n`,
    );
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      name: 'Islands Dark (yours)',
      base: 'islands-dark',
      tokens: { 'abe-needs-you': '#a979f7' },
    });
    expect(existsSync(join(root, 'mine/themes/islands-dark.json'))).toBe(false);
  });

  test('never a built-in, never an unknown colour', async () => {
    expect(
      await handlers['theme save'](
        { theme: 'islands-dark', name: 'Islands Dark', replace: false },
        ctx(),
      ),
    ).toMatchObject({
      error: { code: 'built-in-theme' },
    });
    expect(
      await handlers['theme save'](
        { theme: 'islands-dark', tokens: '{"nope": "#000000"}', replace: false },
        ctx(),
      ),
    ).toMatchObject({
      error: { code: 'unknown-token' },
    });
  });

  test('a colour that is none is said in words (#177)', async () => {
    expect(
      await handlers['theme save'](
        {
          theme: 'islands-dark-yours',
          tokens: '{"frame-bg": "red", "abe-needs-you": 3}',
          replace: false,
        },
        ctx(),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: 'bad-tokens',
        message:
          '--tokens: frame-bg: red is not a colour like #b589ec (or #rrggbbaa); abe-needs-you: 3 is not a colour like #b589ec (or #rrggbbaa)',
      },
    });
  });

  test('another theme of yours is never written over unasked; --replace says what it replaced (#177)', async () => {
    const file = join(root, 'mine/themes/islands-dark-yours.json');
    const before = readFileSync(file, 'utf8');
    const save = (replace: boolean) =>
      handlers['theme save']({ theme: 'islands-dark', tokens: '{}', replace }, ctx());

    expect(await save(false)).toEqual({
      ok: false,
      error: {
        code: 'theme-exists',
        message:
          'Islands Dark (yours) (islands-dark-yours) is a theme of yours already (1 changed token): --replace to write over it, or save onto it with abe theme save islands-dark-yours, or --name another name',
      },
    });
    expect(readFileSync(file, 'utf8')).toBe(before);
    const replaced = ok(await save(true));

    expect(replaced.replaced).toEqual({ name: 'Islands Dark (yours)', changed: 1 });
    expect(themeSaveText(replaced)).toBe(
      `saved Islands Dark (yours) (islands-dark-yours) to ${file}: 0 changed tokens, replacing your Islands Dark (yours) (1 changed token)\n`,
    );
    // Saving onto your own theme by its slug changes it in place: nothing to ask.
    const onto = ok(
      await handlers['theme save'](
        { theme: 'islands-dark-yours', tokens: '{"frame-bg": "#101010"}', replace: false },
        ctx(),
      ),
    );

    expect(onto.replaced).toBeNull();
  });

  test('show and save take a theme by its name as the list shows it (#177)', async () => {
    const shown = ok(await handlers['theme show']({ theme: 'Islands Dark (yours)' }, ctx()));

    expect(shown.theme.slug).toBe('islands-dark-yours');
    expect(
      ok(
        await handlers['theme save'](
          { theme: 'islands dark (yours)', tokens: '{}', replace: false },
          ctx(),
        ),
      ).slug,
    ).toBe('islands-dark-yours');
  });
});

describe('the watch', () => {
  test('a theme file written or changed is named; nothing changed is no event', () => {
    const seen: string[][] = [];
    const watch = startThemeWatch({
      places: settings.places,
      emit: (files) => seen.push(files),
      every: 3_600_000,
    });

    watch.poll();
    expect(seen).toEqual([]);
    write('mine/themes/islands-dark-warm.json', theme('Islands Dark warm', 'islands-dark', {}));
    write('mine/themes/new.json', theme('New', 'islands-light', {}));
    watch.poll();
    watch.stop();

    expect(seen).toEqual([
      [join(root, 'mine/themes/islands-dark-warm.json'), join(root, 'mine/themes/new.json')],
    ]);
  });
});
