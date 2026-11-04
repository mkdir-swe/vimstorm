/** Feel profiles (#121): one pick that sets a bundle of switches; a value a Layer writes wins. */
import { describe, expect, test } from 'bun:test';
import {
  coreDefaults,
  FEELS,
  listSettings,
  feelBundle,
  feelOf,
  type LayerSource,
  mergeSettings,
  SettingExplainData,
  settingExplainText,
  type SettingKey,
  settingKeys,
} from '../../index';

const repo = (doc: unknown): LayerSource => ({ place: 'repo', file: '/r/abe.yaml', doc });
const local = (doc: unknown): LayerSource => ({
  place: 'local',
  file: '/r/.abe/settings.local.yaml',
  doc,
});
const mine = (doc: unknown): LayerSource => ({
  place: 'machine',
  file: '/me/settings.yaml',
  doc,
});

describe('the Feel', () => {
  test('VimStorm is the default, and its bundle is core’s own defaults', () => {
    const d = coreDefaults();

    expect(d['ui.feel']).toBe('vimstorm');
    const bundle = feelBundle('vimstorm');

    for (const key of settingKeys())
      if (Object.hasOwn(bundle, key))
        expect({ key, value: bundle[key] }).toEqual({ key, value: d[key] });
  });

  test.each<[SettingKey, unknown, unknown]>([
    ['ui.theme', 'islands-dark', 'islands-dark'],
    ['tree.autoReveal', false, true],
    ['tree.singleClick', false, true],
    ['tree.decorations', 'colors', 'letters'],
    ['tree.compactFolders', false, true],
    ['tabs.limit', 10, null],
    ['tabs.dirtyDot', false, true],
    ['tabs.preview', false, true],
    ['files.autoSave', 'onFocusChange', 'off'],
    ['editor.minimap', false, true],
    ['editor.vim', true, false],
  ])('%s: VimStorm %p, VS Code %p', (key, vimstorm, vscode) => {
    const under: Record<string, unknown> = {
      vimstorm: mergeSettings([]).values[key],
      vscode: mergeSettings([mine({ ui: { feel: 'vscode' } })]).values[key],
    };

    expect(under).toEqual({ vimstorm, vscode });
  });

  test('a Feel never sets the theme (#345): dark or light is Appearance › Theme’s alone', () => {
    for (const feel of FEELS) {
      expect(Object.keys(feelBundle(feel))).not.toContain('ui.theme');
      expect(Object.keys(feelBundle(feel))).not.toContain('editor.scheme');
    }
    expect(Object.keys(feelBundle('vscode')).sort()).toEqual([
      'editor.minimap',
      'editor.vim',
      'files.autoSave',
      'tabs.dirtyDot',
      'tabs.limit',
      'tabs.preview',
      'tree.autoReveal',
      'tree.compactFolders',
      'tree.decorations',
      'tree.singleClick',
    ]);
  });

  test('WebStorm is VimStorm with Vim mode off (#131): WebStorm’s keymap, always typing', () => {
    const vimstorm = mergeSettings([]).values;
    const webstorm = mergeSettings([mine({ 'ui.feel': 'webstorm' })]).values;

    expect(webstorm['editor.vim']).toBe(false);
    expect({ ...webstorm, 'ui.feel': 'vimstorm', 'editor.vim': true }).toEqual(vimstorm);
  });

  test('Vim is VimStorm’s switches with Vim mode on (#214): stock Vim keys are the editor’s', () => {
    const vimstorm = mergeSettings([]).values;
    const vim = mergeSettings([mine({ 'ui.feel': 'vim' })]).values;

    expect(vim['editor.vim']).toBe(true);
    expect({ ...vim, 'ui.feel': 'vimstorm' }).toEqual(vimstorm);
    expect(feelOf(vim)).toMatchObject({ feel: 'vim', editor: { vim: true, minimap: false } });
  });

  test('Vim mode you set yourself wins over the Feel', () => {
    const m = mergeSettings([mine({ 'ui.feel': 'vscode', editor: { vim: true } })]);

    expect(m.values['editor.vim']).toBe(true);
    expect(feelOf(m.values).editor).toEqual({ minimap: true, vim: true });
  });

  test('the minimap (#122): on under VS Code, off where you or VS Code’s import say so', () => {
    expect(mergeSettings([mine({ 'ui.feel': 'vscode' })]).values['editor.minimap']).toBe(true);
    const off = mergeSettings([mine({ 'ui.feel': 'vscode', editor: { minimap: false } })]);

    expect(feelOf(off.values).editor).toEqual({ minimap: false, vim: false });
    expect(off.explain('editor.minimap').winner).toBe('individual');
    expect(mergeSettings([mine({ editor: { minimap: true } })]).values['editor.minimap']).toBe(
      true,
    );
  });

  test('a switch you set yourself wins over the Feel', () => {
    const m = mergeSettings([
      mine({ 'ui.feel': 'vscode', tree: { autoReveal: false }, tabs: { limit: 5 } }),
    ]);

    expect(m.values['tree.autoReveal']).toBe(false);
    expect(m.values['tabs.limit']).toBe(5);
    expect(m.values['tree.singleClick']).toBe(true);
    expect(m.explain('tree.autoReveal').winner).toBe('individual');
  });

  test('explain names the Feel as the winner of its value: a step between core and yours (#174)', () => {
    const e = mergeSettings([mine({ 'ui.feel': 'vscode' })]).explain('tree.singleClick');

    expect(e).toMatchObject({ value: true, winner: 'feel', feel: 'vscode' });
    expect(e.layers.slice(0, 3)).toMatchObject([
      { layer: 'core', written: false, applied: true },
      { layer: 'feel', written: true, applied: true, file: null },
      { layer: 'individual', file: '/me/settings.yaml' },
    ]);
    expect(settingExplainText(SettingExplainData.parse(e))).toStartWith(
      'tree.singleClick = true  from Feel VS Code\n  core         false\n  feel vscode  true\n',
    );
  });

  test('a Feel that gives core’s own value is no step: core wins', () => {
    const e = mergeSettings([]).explain('tree.singleClick');

    expect(e).toMatchObject({ value: false, winner: 'core', feel: 'vimstorm' });
    expect(e.layers.map((l) => l.layer)).toEqual(['core', 'individual']);
  });

  test('an unknown Feel is dropped: the value above (VimStorm) stays', () => {
    const m = mergeSettings([mine({ 'ui.feel': 'emacs' })]);

    expect(m.values['ui.feel']).toBe('vimstorm');
    expect(m.problems.map((p) => p.code)).toEqual(['invalid-setting']);
  });

  test('tabs.limit takes a count or null (no limit)', () => {
    expect(mergeSettings([mine({ tabs: { limit: null } })]).values['tabs.limit']).toBeNull();
    expect(mergeSettings([mine({ tabs: { limit: 0 } })]).problems.map((p) => p.code)).toEqual([
      'invalid-setting',
    ]);
  });

  test('feelOf: the switches the shell honours, grouped as the feel effect carries them', () => {
    expect(feelOf(mergeSettings([mine({ 'ui.feel': 'vscode' })]).values)).toEqual({
      feel: 'vscode',
      tree: { autoReveal: true, singleClick: true, decorations: 'letters', compactFolders: true },
      tabs: { limit: null, dirtyDot: true, preview: true },
      files: { autoSave: 'off' },
      editor: { minimap: true, vim: false },
      chat: { openByDefault: true, width: 420 },
      keys: [],
    });
    expect(FEELS).toEqual(['vimstorm', 'webstorm', 'vscode', 'vim']);
  });

  test("the Feel is yours on this Mac: a repo's file writing it is dropped", () => {
    for (const above of [repo, local]) {
      const m = mergeSettings([above({ 'ui.feel': 'vscode' })]);

      expect(m.values['ui.feel']).toBe('vimstorm');
      expect(m.values['tabs.preview']).toBe(false);
      expect(m.problems.map((p) => p.code)).toEqual(['not-in-repo']);
    }
  });

  test('without a Layer the switches still start from the whole merge’s Feel (what yours differs from)', () => {
    const m = mergeSettings([mine({ 'ui.feel': 'vscode', tabs: { limit: 5, preview: true } })]);
    const above = m.without('individual');

    // removing your tabs entries gives your Feel's values, not VimStorm's
    expect(above.values['tabs.limit']).toBeNull();
    expect(above.values['tabs.preview']).toBe(true);
    expect(m.values['tabs.limit']).toBe(5);
    // the Feel itself is yours: without your Layer it is core's
    expect(above.values['ui.feel']).toBe('vimstorm');
  });

  test('settings list: a switch you set under your Feel differs from the Feel’s value', () => {
    const rows = listSettings(
      mergeSettings([mine({ 'ui.feel': 'vscode', tabs: { limit: 5, preview: true } })]),
    ).rows;

    expect(rows.find((r) => r.id === 'tabs.preview')?.differs).toBeFalsy();
    expect(rows.find((r) => r.id === 'tabs.limit')?.differs).toMatchObject({
      value: null,
      text: 'yours · Feel VS Code has no limit',
    });
  });

  test('settings list: a switch your Feel sets shows as from the Feel, not as yours (#174)', () => {
    const rows = listSettings(mergeSettings([mine({ 'ui.feel': 'vscode' })])).rows;
    const reveal = rows.find((r) => r.id === 'tree.autoReveal');
    const feel = rows.find((r) => r.id === 'ui.feel');

    expect(reveal).toMatchObject({
      value: true,
      source: { kind: 'feel', layer: 'feel', text: 'from Feel VS Code' },
    });
    expect(reveal?.differs).toBeFalsy();
    expect(feel).toMatchObject({ value: 'vscode', source: { text: 'yours' } });
  });
});
