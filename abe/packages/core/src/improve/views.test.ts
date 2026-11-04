import { describe, expect, test } from 'bun:test';
import { improvePrompt, settingCells } from './improve';
import { mergeSettings } from '../layer/settings/layers';
import { viewNodeOf, viewProblems, ViewTweak } from './views';

const mine = (doc: unknown) =>
  mergeSettings([{ place: 'machine', file: '/me/settings.yaml', doc }]);

describe('views: the personal setting of view tweaks', () => {
  test('a tweak does exactly one of hide, order, label or group', () => {
    expect(ViewTweak.safeParse({ screen: 'factory', node: 'lane:Done', hide: true }).success).toBe(
      true,
    );
    expect(ViewTweak.safeParse({ screen: 'factory', node: 'lane:PR', order: 0 }).success).toBe(
      true,
    );
    expect(
      ViewTweak.safeParse({ screen: 'factory', node: 'lane:PR', label: 'Pull requests' }).success,
    ).toBe(true);
    expect(
      ViewTweak.safeParse({ screen: 'factory', node: 'lane:PR', hide: true, label: 'x' }).success,
    ).toBe(false);
    expect(
      ViewTweak.safeParse({ screen: 'factory', node: 'stripe:git', group: 'top' }).success,
    ).toBe(true);
    expect(
      ViewTweak.safeParse({ screen: 'factory', node: 'stripe:git', group: 'top', hide: true })
        .success,
    ).toBe(false);
    expect(ViewTweak.safeParse({ screen: 'factory', node: 'lane:PR' }).success).toBe(false);
    expect(ViewTweak.safeParse({ screen: 'factory', node: 'lane:PR', colour: 'red' }).success).toBe(
      false,
    );
  });

  test('node ids are the screen’s, a pattern’s part filled in', () => {
    expect(viewNodeOf('factory', 'board-head')?.what).toBe('the Board’s header');
    expect(viewNodeOf('factory', 'col:Active')?.id).toBe('col:<state>');
    expect(viewNodeOf('factory', 'col:')).toBeUndefined();
    expect(viewNodeOf('factory', 'lane:Done')).toBeUndefined();
    expect(viewNodeOf('nowhere', 'col:Active')).toBeUndefined();
  });

  test('a written tweak naming no node of its screen is refused: unknown-node', () => {
    const ok = mine({ views: [{ screen: 'factory', node: 'col:Closed', hide: true }] });

    expect(ok.problems).toEqual([]);
    expect(ok.values.views).toEqual([{ screen: 'factory', node: 'col:Closed', hide: true }]);
    const bad = mine({ views: [{ screen: 'factory', node: 'shipping', hide: true }] });

    expect(bad.problems.map((p) => p.code)).toEqual(['unknown-node']);
    expect(bad.problems[0]?.message).toContain('factory has no node shipping');
    // the entry is dropped: core's default stays
    expect(bad.values.views).toEqual([]);
    expect(viewProblems([{ screen: 'editor', node: 'x', hide: true }]).map((p) => p.code)).toEqual([
      'unknown-node',
    ]);
  });

  test('a Sheet has nodes a tweak may name', () => {
    const tweaks: ViewTweak[] = [{ screen: 'factory', node: 'sheet-view', order: 0 }];

    expect(viewProblems(tweaks)).toEqual([]);
  });

  test('a label on a part with no words of its own is refused, a group on a part not on the stripe too', () => {
    expect(viewProblems([{ screen: 'chat', node: 'chat', label: 'Talk' }])).toEqual([
      {
        code: 'invalid-setting',
        message: 'views: chat chat has no words of its own to relabel; hide or order it',
      },
    ]);
    expect(viewProblems([{ screen: 'factory', node: 'board-head', group: 'top' }])).toEqual([
      {
        code: 'invalid-setting',
        message: 'views: factory board-head is no stripe item to move to a group',
      },
    ]);
    expect(
      viewProblems([
        { screen: 'factory', node: 'stripe:git', group: 'top' },
        { screen: 'factory', node: 'stripe:prototype', hide: true },
      ]),
    ).toEqual([]);
  });

  test("views are yours on this Mac: the repo's file may not write them", () => {
    const merged = mergeSettings([
      {
        place: 'repo',
        file: '/repo/abe.yaml',
        doc: { views: [{ screen: 'factory', node: 'col:Closed', hide: true }] },
      },
    ]);

    expect(merged.problems.map((p) => p.code)).toEqual(['not-in-repo']);
  });

  test('Improve’s prompt lists each screen’s node ids', () => {
    const prompt = improvePrompt({
      wish: 'hide the Closed column',
      files: [],
      nvim: [],
    });

    expect(prompt).toContain(
      '- `factory` `col:<state>`: a Board column, by its state (`col:Active`)',
    );
    expect(prompt).not.toContain('lane:');
    expect(prompt).toContain('- `chat` `chat`: Chat, at the right (hide or order only)');
    expect(prompt).toContain('`{ screen, node, hide: true }`');
    expect(prompt).not.toContain('alsoShow');
    expect(prompt).toContain('`views` (default []): your view tweaks');
  });
});

describe('Improve asked for changes', () => {
  test('the prompt holds the proposal it changes, its files as proposed', () => {
    const prompt = improvePrompt({
      wish: 'hide the Done lane, and only that',
      files: [],
      nvim: [],
      again: {
        summary: 'Hide the Done lane',
        files: [
          { path: 'settings.yaml', before: null, after: 'views: []\n' },
          { path: 'keys.json', before: '{}\n', after: null },
        ],
      },
    });

    expect(prompt).toContain('## The proposal to change');
    expect(prompt).toContain('“Hide the Done lane”');
    expect(prompt).toContain('### settings.yaml\n\n```\nviews: []\n```');
    expect(prompt).toContain('### keys.json\n\n(deleted)');
  });
});

describe('settingCells: a settings change as before and after cells', () => {
  test('set, changed, overridden and removed settings', () => {
    expect(
      settingCells(
        {
          skillsOnTop: false,
          overrides: { autoMerge: { value: true, reason: 'x' } },
        },
        {
          skillsOnTop: true,
          alsoShow: ['terminal'],
        },
      ),
    ).toEqual([
      { key: 'skillsOnTop', before: false, after: true },
      { key: 'alsoShow', before: null, after: ['terminal'] },
      { key: 'autoMerge (override)', before: { value: true, reason: 'x' }, after: null },
    ]);
  });
});
