/**
 * The Settings dialog (#108 S2) through its layer, as the bridge drives it: opened, its reads
 * answered from core's own list and problems over the demo shop's Layers, then keys and clicks.
 */
import { describe, expect, test } from 'bun:test';
import {
  type BrowserListData,
  type LayerSource,
  type LoginStatusData,
  type SettingsImportData,
  type SettingsListData,
  SettingValue,
  type Theme,
  themeCatalogue,
  themeGroups,
  themeRow,
  toolCheck,
  type SourcesData,
  type ToolsCheckData,
} from '@abe/core';
import {
  CLEAN_LAYERS,
  DEMO_LAYERS,
  OVERRIDE_LAYERS,
  RECORDS_LAYERS,
  SETTINGS_RULES,
  settingsList,
  settingsListAnswer,
  settingsProblemsAnswer,
  settingsProblemsData,
} from '@abe/testing';
import { type Node, type Table } from '../runtime/components';
import { type Command, type Input, mountLayer, type MountedLayer } from '../runtime/runtime';
import { cliArgv, SETTINGS_WORD, settingsLayer } from './settings';
import {
  type CheckRow,
  type SettingRow,
  type SettingsDialog,
  type SettingsFix,
  type SettingsPropose,
  type SettingsTreeRow,
} from './settings-components';

const SIZE = { width: 1440, height: 900 };

type Opened = { l: MountedLayer; first: Command[] };

/** The dialog opened and its two reads answered. */
const open = (
  params: Record<string, string> = {},
  layers: readonly LayerSource[] = DEMO_LAYERS,
  checks = true,
): Opened => {
  const l = mountLayer(settingsLayer(SETTINGS_RULES));
  const first = l.send({ kind: 'open', params, size: SIZE });

  l.send(settingsListAnswer('settings:list:1', settingsList(layers)));
  l.send(settingsProblemsAnswer('settings:problems:2', settingsProblemsData(layers, checks)));

  return { l, first };
};

const key = (l: MountedLayer, ...keys: string[]): Command[] =>
  keys.flatMap((k) => l.send({ kind: 'key', key: k }));

const click = (l: MountedLayer, id: string): Command[] => l.send({ kind: 'click', id });

const dialog = (l: MountedLayer): SettingsDialog => {
  const t = l.tree;

  if (t?.kind !== 'SettingsDialog') throw new Error(`no dialog: ${JSON.stringify(t)}`);

  return t;
};

const kids = (n: Node | undefined): Node[] =>
  n !== undefined && 'children' in n ? (n.children ?? []) : [];

const treeRows = (l: MountedLayer): SettingsTreeRow[] => {
  const t = dialog(l).children[0];

  return t?.kind === 'SettingsTree' ? t.props.nodes : [];
};

const pageOf = (l: MountedLayer): Node | undefined => dialog(l).children[1];

const crumbs = (l: MountedLayer) => {
  const p = pageOf(l);

  return p?.kind === 'SettingsPage' ? p.props.crumbs.join(' › ') : '';
};

/** Every row on the page, groups opened. */
const rows = (l: MountedLayer): Node[] => {
  const out: Node[] = [];
  const walk = (n: Node) => {
    if (n.kind === 'SettingRow' || n.kind === 'ProblemRow' || n.kind === 'SettingsEmpty')
      out.push(n);
    for (const c of kids(n)) walk(c);
  };

  for (const c of kids(pageOf(l))) walk(c);

  return out;
};

const settingRows = (l: MountedLayer): SettingRow[] =>
  rows(l).filter((n): n is SettingRow => n.kind === 'SettingRow');

const row = (l: MountedLayer, label: string): SettingRow => {
  const r = settingRows(l).find((x) => x.props.label === label);

  if (r === undefined)
    throw new Error(
      `no row ${label}: ${settingRows(l)
        .map((x) => x.props.label)
        .join(', ')}`,
    );

  return r;
};

const focused = (l: MountedLayer) =>
  rows(l).find(
    (n) => (n.kind === 'SettingRow' || n.kind === 'ProblemRow') && n.props.focused === true,
  );

/** The row with this label on `page`, focused by a click. */
const at = (l: MountedLayer, page: string, label: string): SettingRow => {
  click(l, `settings:tree:${page}`);
  const id = row(l, label).id ?? '';

  click(l, id);

  return row(l, label);
};

const statusOf = (cs: readonly Command[]) =>
  cs.flatMap((c) => (c.kind === 'shell' && c.effect.kind === 'status' ? [c.effect.text] : []));

const runs = (cs: readonly Command[]) => cs.flatMap((c) => (c.kind === 'run' ? [c] : []));

/** `abe settings set`'s answer: written to yours. */
const setAnswer = (id: string, key: string, written: unknown): Input => ({
  kind: 'result',
  id,
  command: 'settings set',
  reply: {
    ok: true,
    data: {
      key,
      layer: 'individual',
      place: 'machine',
      file: '/home/me/.config/abe/settings.yaml',
      entry: 'plain',
      written: SettingValue.parse(written),
      reason: null,
      value: SettingValue.parse(written),
      winner: 'individual',
    },
  },
});

/** `abe settings explain`'s answer: what your Layer's file writes for the key. */
const explainAnswer = (id: string, key: string, mine: unknown): Input => ({
  kind: 'result',
  id,
  command: 'settings explain',
  reply: {
    ok: true,
    data: {
      key,
      value: {},
      winner: 'individual',
      lowered: null,
      layers: [
        {
          layer: 'individual',
          file: '/home/me/.config/abe/settings.yaml',
          entry: 'plain',
          written: SettingValue.parse(mine),
          reason: null,
          applied: true,
        },
      ],
      feel: 'vimstorm',
      problems: [],
    },
  },
});

describe('the Settings dialog opens', () => {
  test('it reads the rows and the problems each time, and is a layer until closed', () => {
    const { l, first } = open();

    // Appearance, the page it opens on until Problems answers, reads its themes
    expect(runs(first).map((r) => r.argv)).toEqual([
      ['settings', 'list', '--files-only'],
      ['settings', 'list'],
      ['settings', 'problems', '--files-only'],
      ['settings', 'problems'],
      ['theme', 'list'],
    ]);
    expect(dialog(l).props.title).toBe('Settings');
    key(l, '<Esc>');
    expect(l.tree).toBeUndefined();
    // opened again: read again (the login and tool checks run each time it opens)
    expect(runs(l.send({ kind: 'open', params: {}, size: SIZE })).map((r) => r.argv)).toEqual([
      ['settings', 'list', '--files-only'],
      ['settings', 'list'],
      ['settings', 'problems', '--files-only'],
      ['settings', 'problems'],
    ]);
  });

  test('the tree is Behaviour 2 in order, Problems first while there are any', () => {
    const { l } = open();

    expect(treeRows(l).map((r) => `${'  '.repeat(r.depth)}${r.label}`)).toEqual([
      'Problems',
      'Appearance & Behavior',
      '  Appearance',
      '  Import config',
      'Editor',
      '  General',
      '  Font',
      '  Color scheme',
      '  Vim',
      'Abe',
      '  Agents & models',
      '  Board & you',
      '  Boxes & cloud',
      '    Browser profiles',
      '  Factory policy',
      '  Local mode',
      '  Reach',
      'Logins & tools',
      'Tools check',
    ]);
    const problems = treeRows(l)[0];

    expect(problems).toMatchObject({ count: { text: '· 3', tone: 'warn' }, separator: true });
    // a page with problems says how many, dim
    expect(treeRows(l).find((r) => r.label === 'Logins & tools')?.count).toEqual({
      text: '2',
      tone: 'dim',
    });
    // it lands on Problems
    expect(crumbs(l)).toBe('Problems · 3');
    expect(treeRows(l).find((r) => r.selected === true)?.label).toBe('Problems');
  });

  test('with no problems the tree row is gone and it opens on Appearance', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    expect(treeRows(l).map((r) => r.label)).not.toContain('Problems');
    expect(crumbs(l)).toBe('Appearance & Behavior › Appearance');
    const page = pageOf(l);

    expect(page?.kind === 'SettingsPage' ? page.props.scope : '').toBe('demo-shop');
  });

  test('it opens on a page asked for (a refusal’s Open Settings), the row focused', () => {
    const { l } = open({ page: 'boxes-cloud', row: 'box.idleMinutes' });

    expect(crumbs(l)).toBe('Abe › Boxes & cloud');
    expect(focused(l)).toMatchObject({ props: { label: 'Idle stop' } });
    expect(dialog(l).props.focus).toBe('page');
  });

  test('`:settings` is a word of Command mode that opens it', () => {
    expect(SETTINGS_WORD.word).toBe('settings');
    expect(SETTINGS_WORD.commands).toEqual([{ kind: 'open', screen: 'settings' }]);
  });
});

describe('the tree’s keys', () => {
  test('l ö move, k folds, ä unfolds and enters the page, gg G, Tab cycles', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    click(l, 'settings:tree:appearance-behavior');
    key(l, 'k');
    expect(treeRows(l).find((r) => r.label === 'Appearance & Behavior')?.fold).toBe('closed');
    expect(treeRows(l).map((r) => r.label)).not.toContain('Import config');
    // a group with no page shows its first child's
    expect(crumbs(l)).toBe('Appearance & Behavior › Appearance');
    key(l, 'ä');
    expect(treeRows(l).map((r) => r.label)).toContain('Import config');
    key(l, 'ä');
    expect(treeRows(l).find((r) => r.selected === true)?.label).toBe('Appearance');
    key(l, 'ö');
    expect(crumbs(l)).toBe('Appearance & Behavior › Import config');
    key(l, 'l');
    key(l, 'ä');
    expect(dialog(l).props.focus).toBe('page');
    expect(focused(l)).toMatchObject({ props: { label: 'Feel' } });
    key(l, 'G');
    expect(focused(l)).toMatchObject({ props: { label: 'View tweaks' } });
    key(l, 'g', 'g');
    expect(focused(l)).toMatchObject({ props: { label: 'Feel' } });
    // End / Home as G / gg (#334)
    key(l, '<End>');
    expect(focused(l)).toMatchObject({ props: { label: 'View tweaks' } });
    key(l, '<Home>');
    expect(focused(l)).toMatchObject({ props: { label: 'Feel' } });
    key(l, 'k');
    expect(dialog(l).props.focus).toBe('tree');
    key(l, 'G');
    expect(treeRows(l).find((r) => r.selected === true)?.label).toBe('Tools check');
    key(l, '<Home>');
    expect(treeRows(l).find((r) => r.selected === true)?.label).not.toBe('Tools check');
    key(l, '<End>');
    expect(treeRows(l).find((r) => r.selected === true)?.label).toBe('Tools check');
    key(l, '<Tab>');
    expect(dialog(l).props.focus).toBe('page');
    key(l, '<Tab>');
    expect(dialog(l).props.focus).toBe('close');
    // round to the search field (#152), then the tree
    key(l, '<Tab>');
    expect(dialog(l).props.focus).toBe('search');
    key(l, '<Tab>');
    expect(dialog(l).props.focus).toBe('tree');
  });
});

describe('a page’s groups', () => {
  test('a group of one row has no caption: its label says it (FEEL above Feel)', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    at(l, 'appearance', 'Feel');
    expect(
      kids(pageOf(l)).map((g) => [
        g.kind === 'SettingsGroup' ? g.props.caption : g.kind,
        kids(g).length,
      ]),
    ).toEqual([
      [undefined, 1],
      ['Theme', 2],
      [undefined, 1],
      ['Font', 3],
      [undefined, 1],
      [undefined, 1],
    ]);
  });
});

describe('a setting row', () => {
  test('the value first, the source line under it, the focused row’s hint', () => {
    const { l } = open({}, DEMO_LAYERS);

    expect(at(l, 'boxes-cloud', 'Largest disk').props).toMatchObject({
      // a number's field is 72 wide with its unit after it (#345)
      control: { kind: 'field', text: '300', size: 'number', unit: 'GB' },
      help: 'a box disk grows by itself up to this',
      source: { text: 'Repo' },
      hint: '⏎ change for me · ⌘⏎ propose for the repo',
      focused: true,
    });
    // Abe's pages say every row's source, built-in too: Repo, Yours or built-in at a glance
    expect(row(l, 'Max boxes per person').props.source).toEqual({ text: 'built-in' });
    expect(row(l, 'Max boxes per person').props.hint).toBeUndefined();
    // the editor's built-in value says nothing (#345): no `built-in` under every row
    expect(at(l, 'editor-font', 'Ligatures').props.source).toEqual({ text: '' });
    // yours differing from the default says both
    expect(at(l, 'appearance', 'Chat column open by default').props).toMatchObject({
      control: { kind: 'checkbox', on: false },
      source: { text: 'yours · the default is on' },
    });
    // a personal-only key is not for the repo; an account's combo takes a name typed too
    expect(at(l, 'board-team', 'GitHub login').props.hint).toBe(
      '⏎ choose or type · yours alone: not for the repo',
    );
  });

  test('a model outside allowedModels is greyed with why; the combo passes over it', () => {
    const { l } = open();

    expect(at(l, 'agents', 'Reader').props.source.text).toBe(
      "built-in · haiku greyed, not in the repo's allowedModels",
    );
    key(l, '<CR>');
    const combo = row(l, 'Reader').props.control;

    expect(combo).toEqual({
      kind: 'combo',
      value: 'sonnet',
      open: {
        choices: [
          { id: 'settings:choice:0', text: 'opus' },
          { id: 'settings:choice:1', text: 'sonnet' },
          { id: 'settings:choice:2', text: 'haiku', greyed: "not in the repo's allowedModels" },
        ],
        cursor: 1,
        filter: '',
      },
    });
    // haiku is greyed: the cursor passes it over
    key(l, '<Down>');
    expect(row(l, 'Reader').props.control).toMatchObject({ open: { cursor: 1 } });
    // every letter types into its filter, k and ä too
    key(l, 'k', 'ä');
    expect(row(l, 'Reader').props.control).toMatchObject({ open: { filter: 'kä' } });
    key(l, '<BS>', '<BS>', '<Up>', '<CR>');
    expect(row(l, 'Reader').props).toMatchObject({
      control: { kind: 'combo', value: 'opus' },
      source: { text: 'yours · saving…', tone: 'link' },
      changed: true,
    });
  });

  test("Your MCP servers, never a repo's: yours by default, abe-only a pick away, saying a repo's own never load and MCP tools are outside Abe's fence", () => {
    const { l } = open({}, CLEAN_LAYERS, false);
    const r = at(l, 'agents', "Your MCP servers, never a repo's");

    expect(r.props).toMatchObject({
      control: { kind: 'segmented', choices: ['Yours too', "Abe's only"], on: 'Yours too' },
      source: { text: 'built-in' },
    });
    expect(r.props.help).toContain(
      "a repo's own never load, in any session · MCP tools run outside the sandbox and aren't checked by Abe's fence",
    );
    key(l, '<CR>', 'ä', '<CR>');
    expect(row(l, "Your MCP servers, never a repo's").props).toMatchObject({
      control: { kind: 'segmented', on: "Abe's only" },
      changed: true,
    });
  });

  test('a fixed line: ⏎ opens nothing and says why', () => {
    const { l } = open();
    const r = at(l, 'agents', 'Overrides require a reason');

    expect(r.props).toMatchObject({
      control: { kind: 'checkbox', on: true, fixed: true },
      source: { text: 'fixed · an Override always needs its reason' },
    });
    expect(r.props.hint).toBeUndefined();
    expect(statusOf(key(l, '<CR>'))).toEqual([
      'Overrides require a reason is fixed: an Override always needs its reason',
    ]);
    expect(row(l, 'Overrides require a reason').props.changed).toBeUndefined();
  });
});

describe('a change saves at once, ⌘Z takes it back', () => {
  test('⏎ writes yours at once; its answer says it, offers Undo and reads the rows again', () => {
    const { l } = open();

    at(l, 'appearance', 'Chat column open by default');
    const [w] = runs(key(l, '<CR>'));

    expect(w?.argv).toEqual(['settings', 'set', 'chat.openByDefault', 'true']);
    expect(row(l, 'Chat column open by default').props).toMatchObject({
      control: { kind: 'checkbox', on: true },
      source: { text: 'yours · saving…' },
      changed: true,
    });
    expect(dialog(l).props.note).toBe('Saving 1 change…');
    expect(treeRows(l).find((r) => r.label === 'Appearance')?.modified).toBe(true);
    const done = l.send(setAnswer(w?.id ?? '', 'chat.openByDefault', true));
    const [again] = runs(done);

    expect(statusOf(done)).toEqual(['Saved Chat column open by default']);
    expect(again?.argv).toEqual(['settings', 'list']);
    expect(dialog(l).props).toMatchObject({
      note: 'Saved Chat column open by default · ⌘Z undoes',
      undo: { id: 'settings:undo', label: 'Undo' },
    });
    // the row keeps the change until the rows read after it say it
    expect(row(l, 'Chat column open by default').props.source.text).toBe('yours · saved');
    l.send(settingsListAnswer(again?.id ?? '', settingsList(CLEAN_LAYERS)));
    expect(row(l, 'Chat column open by default').props.changed).toBeUndefined();
    expect(l.tree).toBeDefined();
  });

  test('a pick of the value shown writes nothing; Esc closes at once, nothing asked', () => {
    const { l } = open();

    at(l, 'agents', 'Coordinator');
    expect(runs(key(l, '<CR>', '<CR>'))).toEqual([]);
    expect(row(l, 'Coordinator').props.changed).toBeUndefined();
    at(l, 'appearance', 'Chat column open by default');
    key(l, '<Space>');
    key(l, '<Esc>');
    expect(l.tree).toBeUndefined();
  });

  test('a write refused: the row as it was, the reason under it, nothing saved', () => {
    const { l } = open();

    at(l, 'board-team', 'GitHub login');
    const [w] = runs(key(l, '<CR>', 'w', 'e', 'b', '<CR>'));

    expect(w?.argv).toEqual(['settings', 'set', 'githubIdentity', 'web']);
    l.send({
      kind: 'result',
      id: w?.id ?? '',
      command: 'settings set',
      reply: { ok: false, error: { code: 'invalid-setting', message: 'no' } },
    });
    expect(row(l, 'GitHub login').props).toMatchObject({
      control: { kind: 'combo', value: 'none' },
      error: 'no (invalid-setting)',
    });
    expect(row(l, 'GitHub login').props.changed).toBeUndefined();
    expect(dialog(l).props).toMatchObject({
      note: '1 change refused, nothing saved · see the rows',
      noteTone: 'bad',
    });
    expect(dialog(l).props.undo).toBeUndefined();
  });

  test('lowering an upper value asks its reason in place; ⏎ writes an Override', () => {
    const { l } = open();

    at(l, 'boxes-cloud', 'Idle stop');
    expect(runs(key(l, '<CR>', '<BS>', '<BS>', '4', '5', '<CR>'))).toEqual([]);
    expect(row(l, 'Idle stop').props.reason).toEqual({ text: '' });
    key(l, '<CR>');
    expect(row(l, 'Idle stop').props.reason?.error).toBe(
      'An Override needs its reason (override-needs-reason)',
    );
    l.send({ kind: 'text', text: 'long builds' });
    expect(runs(key(l, '<CR>')).map((w) => w.argv)).toEqual([
      ['settings', 'set', 'box.idleMinutes', '45', '--override', '--reason=long builds'],
    ]);
    expect(row(l, 'Idle stop').props).toMatchObject({ changed: true, control: { text: '45' } });
  });

  test('a field of an object setting writes the whole object yours holds, that field changed', () => {
    const { l } = open();

    at(l, 'board-team', 'Done moves the card to');
    key(l, '<CR>');
    l.send({ kind: 'text', text: 'Resolved' });
    const [explain] = runs(key(l, '<CR>'));

    expect(explain?.argv).toEqual(['settings', 'explain', 'board']);
    const [set] = runs(l.send(explainAnswer(explain?.id ?? '', 'board', { project: 'Shop' })));

    expect(set?.argv).toEqual(['settings', 'set', 'board', '{"project":"Shop","done":"Resolved"}']);
  });

  test('⌘S with a field open takes its value as ⏎ does; with none it says changes save as made', () => {
    const { l } = open();

    at(l, 'boxes-cloud', 'Largest disk');
    key(l, '<CR>', '<BS>', '<BS>', '<BS>', '2', '0', '0');
    expect(runs(key(l, '<D-s>')).map((w) => w.argv)).toEqual([
      ['settings', 'set', 'limits.maxBoxDisk', '200'],
    ]);
    expect(statusOf(key(l, '<D-s>'))).toEqual(['Settings save as you change them']);
  });

  test('⌘Z (and Undo) writes back what the last save changed: yours taken out, or yours as it was', () => {
    const { l } = open();

    expect(statusOf(key(l, '<D-z>'))).toEqual(['Nothing to undo']);
    // the default was in force: undo takes yours out
    at(l, 'editor-general', 'Tab limit');
    const [w] = runs(key(l, '<CR>', '<D-a>', '5', '<CR>'));

    expect(w?.argv).toEqual(['settings', 'set', 'tabs.limit', '5']);
    l.send(setAnswer(w?.id ?? '', 'tabs.limit', 5));
    const back = key(l, '<D-z>');

    expect(runs(back).map((x) => x.argv)).toEqual([['settings', 'unset', 'tabs.limit']]);
    expect(statusOf(back)).toEqual(['Undoing Tab limit']);
    expect(dialog(l).props.undo).toBeUndefined();
    // yours was set (Chat closed by default): undo writes it back, the button too
    at(l, 'appearance', 'Chat column open by default');
    const [c] = runs(key(l, '<Space>'));

    l.send(setAnswer(c?.id ?? '', 'chat.openByDefault', true));
    expect(runs(click(l, 'settings:undo')).map((x) => x.argv)).toEqual([
      ['settings', 'set', 'chat.openByDefault', 'false'],
    ]);
  });

  test('Tab reaches Close; ⏎ there closes', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    key(l, '<Tab>', '<Tab>');
    expect(dialog(l).props.focus).toBe('close');
    key(l, '<CR>');
    expect(l.tree).toBeUndefined();
  });
});

/** The propose popup in the dialog's tree. */
const popup = (l: MountedLayer): SettingsPropose => {
  const p = dialog(l).children.find((c): c is SettingsPropose => c.kind === 'SettingsPropose');

  if (p === undefined) throw new Error('no propose popup');

  return p;
};

const hasPopup = (l: MountedLayer) => dialog(l).children.some((c) => c.kind === 'SettingsPropose');

/** `abe settings propose`'s answer: the pull request opened. */
const proposeAnswer = (id: string, updated = false): Input => ({
  kind: 'result',
  id,
  command: 'settings propose',
  reply: {
    ok: true,
    data: {
      key: 'limits.maxBoxDisk',
      field: null,
      label: 'Largest disk',
      repo: 'demo/shop',
      path: 'abe.yaml',
      branch: 'settings/repo/limits.maxBoxDisk',
      base: 'main',
      from: '300',
      value: '400',
      entry: 'plain',
      pr: { number: 14, url: 'https://github.com/demo/shop/pull/14' },
      updated,
    },
  },
});

describe('⌘⏎ proposes for the repo (S-Propose)', () => {
  test('the popup: the value now → the one proposed, the reason, where the pull request opens', () => {
    const { l } = open();

    at(l, 'boxes-cloud', 'Largest disk');
    key(l, '<D-CR>');
    expect(popup(l).props).toMatchObject({
      title: 'Propose for repo demo-shop',
      label: 'Largest disk',
      value: { kind: 'field', from: '300', to: '300' },
      focus: 'value',
      where: 'opens a pull request on this repo · abe.yaml',
      cancel: { id: 'settings:propose:cancel' },
      open: { id: 'settings:propose:open', label: 'Open pull request' },
    });
  });

  test('a value and a reason, ⏎ opens one pull request; its answer says it and reads the rows again', () => {
    const { l } = open();

    at(l, 'boxes-cloud', 'Largest disk');
    key(l, '<D-CR>', '<C-u>');
    l.send({ kind: 'text', text: '400' });
    key(l, '<Tab>');
    expect(popup(l).props.focus).toBe('reason');
    l.send({ kind: 'text', text: 'long builds' });
    // k l ö ä type in the reason
    key(l, ' ', 'k');
    const sent = runs(key(l, '<CR>'));

    expect(sent.map((c) => c.argv)).toEqual([
      ['settings', 'propose', 'limits.maxBoxDisk', '400', '--reason=long builds k'],
    ]);
    expect(popup(l).props.busy).toBe(true);
    const done = l.send(proposeAnswer(sent[0]?.id ?? ''));

    expect(hasPopup(l)).toBe(false);
    expect(statusOf(done)).toEqual(['Pull request #14 open for the repo: Largest disk → 400']);
    expect(runs(done).map((c) => c.argv)).toEqual([['settings', 'list']]);
    // nothing saved for you: a proposal is never a change of yours
    expect(dialog(l).props.undo).toBeUndefined();
  });

  test('a row with open pull requests says PRs #N open after its source', () => {
    const l = mountLayer(settingsLayer(SETTINGS_RULES));
    const list = settingsList(DEMO_LAYERS);

    l.send({ kind: 'open', params: { page: 'boxes-cloud' }, size: SIZE });
    l.send(
      settingsListAnswer('settings:list:1', {
        ...list,
        rows: list.rows.map((r) =>
          r.key === 'box.idleMinutes'
            ? {
                ...r,
                prs: [
                  { number: 14, url: 'https://github.com/demo/shop/pull/14' },
                  { number: 3, url: 'https://github.com/demo/shop/pull/3' },
                ],
              }
            : r,
        ),
      }),
    );
    // #175: every open proposal
    expect(row(l, 'Idle stop').props.pr).toBe('PRs #14, #3 open');
    expect(row(l, 'Box size').props.pr).toBeUndefined();
  });

  test('no reason: it asks for one and sends nothing', () => {
    const { l } = open();

    at(l, 'boxes-cloud', 'Largest disk');
    key(l, '<D-CR>');
    expect(runs(key(l, '<CR>'))).toEqual([]);
    expect(popup(l).props).toMatchObject({
      focus: 'reason',
      error: 'A proposal needs its reason: the pull request opens with it',
    });
  });

  test('a refusal stays in the popup; Esc closes it and the dialog stays', () => {
    const { l } = open();

    at(l, 'boxes-cloud', 'Largest disk');
    key(l, '<D-CR>', '<Tab>');
    l.send({ kind: 'text', text: 'why' });
    const [run] = runs(key(l, '<CR>'));

    l.send({
      kind: 'result',
      id: run?.id ?? '',
      command: 'settings propose',
      reply: { ok: false, error: { code: 'gh-failed', message: 'gh: not logged in' } },
    });
    expect(popup(l).props.error).toBe('gh: not logged in (gh-failed)');
    expect(popup(l).props.busy).toBeUndefined();
    key(l, '<Esc>');
    expect(hasPopup(l)).toBe(false);
    expect(l.tree?.kind).toBe('SettingsDialog');
  });

  test('checks show each name as a chip, its command in the help', () => {
    const { l } = open({}, [
      {
        place: 'repo',
        file: '/p/demo-shop/abe.yaml',
        doc: {
          checks: [
            { name: 'tests', run: 'npm test' },
            { name: 'types', run: 'npm run typecheck' },
            'no-deleted-tests',
          ],
        },
      },
    ]);
    const p = at(l, 'factory-policy', 'Checks').props;

    expect([p.control, p.help]).toEqual([
      {
        kind: 'list',
        // lint and no-new-suppressions are built in: no command written
        items: [
          { text: 'tests', detail: 'npm test' },
          { text: 'types', detail: 'npm run typecheck' },
          ...['lint', 'no-deleted-tests', 'no-new-suppressions'].map((text) => ({ text })),
        ],
      },
      "tests: npm test · types: npm run typecheck · each one's command is its run: in the repo's abe.yaml",
    ]);
  });

  test('a checkbox proposes the other value, for the repo', () => {
    const { l } = open();

    at(l, 'factory-policy', 'Auto merge');
    const now = row(l, 'Auto merge').props.control;

    key(l, '<D-CR>');
    const p = popup(l).props;

    expect(p.value.kind).toBe('toggle');
    expect(p.value.to).toBe(now.kind === 'checkbox' && now.on ? 'off' : 'on');
    expect(p.focus).toBe('reason');
    // one target: Tab never lands on a pick
    key(l, '<S-Tab>');
    expect(popup(l).props.focus).toBe('value');
    expect(popup(l).props.title).toBe('Propose for repo demo-shop');
    expect(popup(l).props.where).toBe('opens a pull request on this repo · abe.yaml');
  });

  test('a combo picks with ↑ ↓ among its choices', () => {
    const { l } = open();

    at(l, 'boxes-cloud', 'Box size');
    key(l, '<D-CR>');
    const from = popup(l).props.value.to;

    key(l, 'l');
    expect(popup(l).props.value.kind).toBe('pick');
    expect(popup(l).props.value.to).not.toBe(from);
    key(l, 'ö');
    expect(popup(l).props.value.to).toBe(from);
  });

  test('a personal setting is yours alone: no popup, the status says so', () => {
    const { l } = open();

    at(l, 'board-team', 'GitHub login');
    const said = statusOf(key(l, '<D-CR>'));

    expect(hasPopup(l)).toBe(false);
    expect(said[0]).toContain('yours alone');
  });

  test('a click on Cancel or Open pull request', () => {
    const { l } = open();

    at(l, 'boxes-cloud', 'Largest disk');
    key(l, '<D-CR>');
    click(l, 'settings:propose:reason');
    l.send({ kind: 'text', text: 'why' });
    expect(runs(click(l, 'settings:propose:open'))).toHaveLength(1);
    const { l: l2 } = open();

    at(l2, 'boxes-cloud', 'Largest disk');
    key(l2, '<D-CR>');
    click(l2, 'settings:propose:cancel');
    expect(hasPopup(l2)).toBe(false);
  });
});

describe('/ searches every page', () => {
  test('results grouped under their page, the tree counts them, Esc returns', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    at(l, 'appearance', 'Density');
    key(l, '/', 'b', 'o', 'x');
    expect(dialog(l).props).toMatchObject({ focus: 'search', search: { text: 'box' } });
    const page = pageOf(l);

    expect(page?.kind === 'SettingsPage' ? page.props : undefined).toMatchObject({
      crumbs: ['Search'],
      scope: '17 results on 4 pages',
    });
    expect(
      kids(page).map((g) => [
        g.kind === 'SettingsGroup' ? g.props.caption : g.kind,
        kids(g).map((r) => (r.kind === 'SettingRow' ? r.props.label : r.kind)),
      ]),
    ).toEqual([
      // the page found by its name first (#152)
      [
        'Boxes & cloud',
        [
          'Boxes & cloud',
          'Max boxes per person',
          'Start size',
          'Box size',
          'Largest disk',
          'Idle stop',
          'Waiting on you',
          // Your environment and Stores (#344)
          'AWS profile',
          'AWS region',
          'Box owner',
          'Session logs',
          'Prototypes and Sheets',
        ],
      ],
      [
        'Agents & models',
        ['My skills on top', 'Local sessions', "Your MCP servers, never a repo's"],
      ],
      // Local mode's line: no boxes (#24)
      ['Local mode', ['Agents']],
      // serve.target: `cloud: your own box per repo` (#139, ADR 0022)
      ['Tools check', ['Commands run']],
    ]);
    expect(treeRows(l).find((r) => r.label === 'Boxes & cloud')?.count).toEqual({
      text: '12',
      tone: 'dim',
    });
    expect(treeRows(l).find((r) => r.label === 'Reach')?.dim).toBe(true);
    // into the results; ⏎ changes a row without opening its page
    key(l, '<CR>', 'ö', 'ö', 'ö', 'ö', 'ö', '<CR>');
    expect(focused(l)).toMatchObject({ props: { label: 'Idle stop', control: { editing: true } } });
    key(l, '<Esc>', '<Esc>');
    expect(dialog(l).props.search.text).toBe('');
    expect(crumbs(l)).toBe('Appearance & Behavior › Appearance');
    expect(focused(l)).toMatchObject({ props: { label: 'Density' } });
    key(l, '<Esc>');
    expect(l.tree).toBeUndefined();
  });

  test('Esc puts the keys back where `/` was pressed: the tree', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    key(l, '/', 'b', 'o', 'x', '<Esc>');
    expect(dialog(l).props.focus).toBe('tree');
  });

  test('no match says so and how', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    key(l, '/', 'x', 'y', 'z', 'q');
    expect(rows(l)).toEqual([
      {
        kind: 'SettingsEmpty',
        props: { title: 'No setting matches "xyzq"', line: 'Try a key name, like box.idleMinutes' },
      },
    ]);
  });
});

describe('search finds pages, the tree walks, ⌘A selects (#152)', () => {
  const selectedRow = (l: MountedLayer) => treeRows(l).find((r) => r.selected === true)?.label;
  const hits = (l: MountedLayer) =>
    settingRows(l)
      .filter((r) => r.props.hit === true)
      .map((r) => r.props.label);

  test('a page name finds the page: its tree row lit, ⏎ on the hit opens it, the search kept', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    key(l, '/', 'I', 'm', 'p', 'o', 'r', 't');
    expect(crumbs(l)).toBe('Search');
    expect(settingRows(l).map((r) => r.props.label)).toEqual(['Import config']);
    expect(row(l, 'Import config').props.source.text).toBe('Appearance & Behavior › Import config');
    const tree = treeRows(l).find((r) => r.label === 'Import config');

    expect(tree?.dim).toBeUndefined();
    expect(tree?.count).toEqual({ text: '1', tone: 'dim' });
    // its group is not greyed: a page under it has hits
    expect(treeRows(l).find((r) => r.label === 'Appearance & Behavior')?.dim).toBeUndefined();
    expect(treeRows(l).find((r) => r.label === 'Reach')?.dim).toBe(true);
    key(l, '<CR>', '<CR>');
    expect(crumbs(l)).toBe('Appearance & Behavior › Import config');
    expect(dialog(l).props.search.text).toBe('Import');
    expect(selectedRow(l)).toBe('Import config');
  });

  test('Tab cycles search → tree → page → Close → search', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    key(l, '/', 'b', 'o', 'x', '<Tab>');
    expect(dialog(l).props.focus).toBe('tree');
    key(l, '<Tab>');
    expect(dialog(l).props.focus).toBe('page');
    key(l, '<Tab>');
    expect(dialog(l).props.focus).toBe('close');
    key(l, '<Tab>');
    expect(dialog(l).props).toMatchObject({ focus: 'search', search: { text: 'box' } });
    key(l, '<S-Tab>');
    expect(dialog(l).props.focus).toBe('close');
  });

  test('Tab out of an empty search leaves no search behind: one Esc closes', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    key(l, '/', '<Tab>');
    expect(dialog(l).props.focus).toBe('tree');
    key(l, '<Esc>');
    expect(l.tree).toBeUndefined();
  });

  test('↑ ↓ walk the tree; while searching only the pages with hits, each shown with its hits marked', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    click(l, 'settings:tree:appearance');
    key(l, '<Down>');
    expect(selectedRow(l)).toBe('Import config');
    key(l, '<Up>');
    expect(selectedRow(l)).toBe('Appearance');
    key(l, '/', 'b', 'o', 'x', '<Tab>');
    // the results stay until a page is picked; the cursor on the first lit node, the group Abe
    expect(crumbs(l)).toBe('Search');
    expect(selectedRow(l)).toBe('Abe');
    key(l, '<Down>');
    expect(selectedRow(l)).toBe('Agents & models');
    expect(crumbs(l)).toBe('Abe › Agents & models');
    expect(hits(l)).toEqual([
      'My skills on top',
      'Local sessions',
      "Your MCP servers, never a repo's",
    ]);
    expect(settingRows(l).length).toBeGreaterThan(2);
    key(l, 'ö');
    expect(selectedRow(l)).toBe('Boxes & cloud');
    expect(hits(l)).toEqual([
      'Max boxes per person',
      'Start size',
      'Box size',
      'Largest disk',
      'Idle stop',
      'Waiting on you',
      'AWS profile',
      'AWS region',
      'Box owner',
      'Session logs',
      'Prototypes and Sheets',
    ]);
    // ⏎ / ä into the page; k back to the tree
    key(l, 'ä');
    expect(dialog(l).props.focus).toBe('page');
    key(l, 'k');
    expect(dialog(l).props.focus).toBe('tree');
    // typing again shows the results
    key(l, '/', 'e');
    expect(crumbs(l)).toBe('Search');
  });

  test('a click on a page while searching shows it, its hits marked, the search kept', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    key(l, '/', 'b', 'o', 'x');
    click(l, 'settings:tree:boxes-cloud');
    expect(crumbs(l)).toBe('Abe › Boxes & cloud');
    expect(selectedRow(l)).toBe('Boxes & cloud');
    expect(dialog(l).props.search.text).toBe('box');
    expect(hits(l)).toEqual([
      'Max boxes per person',
      'Start size',
      'Box size',
      'Largest disk',
      'Idle stop',
      'Waiting on you',
      'AWS profile',
      'AWS region',
      'Box owner',
      'Session logs',
      'Prototypes and Sheets',
    ]);
    // Esc clears the search and stays on the page picked
    key(l, '<Esc>');
    expect(dialog(l).props.search.text).toBe('');
    expect(crumbs(l)).toBe('Abe › Boxes & cloud');
    expect(hits(l)).toEqual([]);
  });

  test('Tab into the tree while searching puts its cursor on a lit page; ⏎ opens that one', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    click(l, 'settings:tree:keymap');
    key(l, '/', 'b', 'o', 'x', '<Tab>');
    expect(selectedRow(l)).toBe('Abe');
    expect(crumbs(l)).toBe('Search');
    key(l, '<CR>');
    expect(crumbs(l)).toBe('Abe › Agents & models');
    expect(hits(l)).toEqual([
      'My skills on top',
      'Local sessions',
      "Your MCP servers, never a repo's",
    ]);
  });

  test('a group lit only by a later page opens that page while searching', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    key(l, '/', 'i', 'd', 'l', 'e', '<Tab>');
    expect(selectedRow(l)).toBe('Abe');
    key(l, '<CR>');
    expect(crumbs(l)).toBe('Abe › Boxes & cloud');
    expect(hits(l)).toEqual(['Idle stop']);
  });

  test('a page clicked after `/` with nothing typed stays on Esc', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    click(l, 'settings:tree:keymap');
    key(l, '/');
    click(l, 'settings:tree:vim');
    key(l, '<Esc>');
    expect(crumbs(l)).toBe('Editor › Vim');
    expect(l.tree).toBeDefined();
  });

  test('⌘A selects the text of the field with the caret: ⌫ clears it, a key types over it', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    key(l, '/', 'b', 'o', 'x', '<D-a>');
    expect(dialog(l).props.selectAll).toBe(true);
    key(l, '<BS>');
    expect(dialog(l).props.search.text).toBe('');
    expect(dialog(l).props.selectAll).toBeUndefined();
    key(l, 'b', 'o', 'x', '<D-a>', 'i');
    expect(dialog(l).props.search.text).toBe('i');
    // a move lets the selection go: the next key types on
    key(l, '<D-a>', '<Right>', 'd');
    expect(dialog(l).props.search.text).toBe('id');
    // pasted text replaces it too
    key(l, '<D-a>');
    l.send({ kind: 'text', text: 'idle' });
    expect(dialog(l).props.search.text).toBe('idle');
    // a setting's field
    key(l, '<Esc>');
    at(l, 'boxes-cloud', 'Idle stop');
    key(l, '<CR>');
    const before = row(l, 'Idle stop').props.control;

    expect(before).toMatchObject({ kind: 'field', editing: true });
    key(l, '<D-a>', '4', '5');
    expect(row(l, 'Idle stop').props.control).toMatchObject({ kind: 'field', text: '45' });
    // nothing to select outside a field, nor in a combo's list
    key(l, '<Esc>', '<D-a>');
    expect(dialog(l).props.selectAll).toBeUndefined();
    at(l, 'boxes-cloud', 'Box size');
    key(l, '<CR>', '<D-a>');
    expect(dialog(l).props.selectAll).toBeUndefined();
  });
});

describe('Problems first', () => {
  test('each problem’s way out: fix… types the command into the strip, open goes to the row', () => {
    const { l } = open();

    click(l, 'settings:tree:problems');
    key(l, 'ä');
    const [aws] = rows(l);

    expect(aws).toMatchObject({
      kind: 'ProblemRow',
      props: {
        text: 'AWS SSO session expired — sign in again',
        where: 'Logins & tools › AWS SSO · sso-session abe',
        way: { label: 'fix…', tone: 'warn' },
        focused: true,
      },
    });
    key(l, '<CR>');
    expect(fixOf(l)?.props).toMatchObject({
      title: 'fix · AWS SSO',
      command: '$ aws sso login --sso-session abe',
      state: 'queued · ⏎ runs it · Esc drops it',
    });
    key(l, '<Esc>');
    expect(fixOf(l)).toBeUndefined();
    key(l, 'ö', 'ö');
    // one button word (#345): a row to go to is a fix too
    expect(focused(l)).toMatchObject({ kind: 'ProblemRow', props: { way: { label: 'fix…' } } });
    key(l, '<CR>');
    expect(crumbs(l)).toBe('Abe › Factory policy');
    expect(focused(l)).toMatchObject({ props: { label: 'Auto merge' } });
    expect(rows(l).at(-1)).toBeDefined();
  });

  test('your Override is an info row (#168): listed, never counted, never landed on', () => {
    const { l } = open({}, OVERRIDE_LAYERS, false);

    // it opens where it would with no problems; the tree row shows, its count dim
    expect(crumbs(l)).toBe('Appearance & Behavior › Appearance');
    expect(treeRows(l)[0]).toMatchObject({
      label: 'Problems',
      count: { text: '· 1', tone: 'dim' },
    });
    expect(treeRows(l).find((r) => r.label === 'Factory policy')?.count).toBeUndefined();
    click(l, 'settings:tree:problems');
    expect(crumbs(l)).toBe('Problems · 0');
    const page = kids(pageOf(l));

    expect(page.filter((n) => n.kind === 'ProblemRow')).toEqual([
      {
        kind: 'ProblemRow',
        id: 'settings:line:0',
        props: {
          text: 'Your Override: auto merge on — my sandbox (since 2026-10-24); it holds for your runs only',
          where: 'Factory policy › Auto merge · your Layer',
          way: { label: 'propose…' },
          info: true,
        },
      },
    ]);
    expect(page.filter((n) => n.kind === 'SettingsNote')).toEqual([
      { kind: 'SettingsNote', props: { text: 'No problems' } },
    ]);
  });

  test('the last line is No other problems', () => {
    const { l } = open();
    const notes = kids(pageOf(l)).filter((n) => n.kind === 'SettingsNote');

    expect(notes).toEqual([{ kind: 'SettingsNote', props: { text: 'No other problems' } }]);
  });
});

/** The fix strip in the dialog's tree. */
const fixOf = (l: MountedLayer): SettingsFix | undefined =>
  dialog(l).children.find((c): c is SettingsFix => c.kind === 'SettingsFix');

const checkRows = (l: MountedLayer): CheckRow[] => {
  const out: CheckRow[] = [];
  const walk = (n: Node) => {
    if (n.kind === 'CheckRow') out.push(n);
    for (const c of kids(n)) walk(c);
  };

  for (const c of kids(pageOf(l))) walk(c);

  return out;
};

const LOGINS: LoginStatusData = {
  secret: null,
  logins: { github: 'ok', claude: 'ok', az: 'expired' },
};

const TOOLS: ToolsCheckData = {
  where: 'this Mac',
  tools: [
    toolCheck('node', { found: false }, false),
    toolCheck('tmux', { found: true, exit: 0, stdout: 'tmux 3.5a', stderr: '' }, false),
  ],
};

/** This checkout's sources: none unless a test says. */
const NO_SOURCES: SourcesData = { repo: '/r/shop', sources: [] };

/** `abe source status` answered: no sources. */
const noSources = (l: MountedLayer, asked: readonly Command[]) =>
  l.send({
    kind: 'result',
    id: runs(asked).find((c) => c.argv.join(' ') === 'source status')?.id ?? '',
    command: 'source status',
    reply: { ok: true, data: NO_SOURCES },
  });

/** Logins & tools shown, its three reads answered. */
const logins = (
  l: MountedLayer,
  tools: ToolsCheckData = TOOLS,
  sources: SourcesData = NO_SOURCES,
): Command[] => {
  const asked = runs(click(l, 'settings:tree:logins-tools'));

  expect(asked.map((c) => c.argv)).toEqual([
    ['login', 'status'],
    ['tools', 'check'],
    ['source', 'status'],
  ]);
  l.send({
    kind: 'result',
    id: asked[0]?.id ?? '',
    command: 'login status',
    reply: { ok: true, data: LOGINS },
  });
  l.send({
    kind: 'result',
    id: asked[1]?.id ?? '',
    command: 'tools check',
    reply: { ok: true, data: tools },
  });
  l.send({
    kind: 'result',
    id: asked[2]?.id ?? '',
    command: 'source status',
    reply: { ok: true, data: sources },
  });

  return asked;
};

describe('Logins & tools (S-Logins)', () => {
  test('a board On this machine: no Azure DevOps login is listed, nor its Board & you fields', () => {
    const { l } = open({}, [
      {
        place: 'repo',
        file: '/p/demo-shop/abe.yaml',
        doc: { board: { provider: 'local', project: 'demo-shop' } },
      },
    ]);

    logins(l);
    expect(checkRows(l).map((r) => r.props.label)).not.toContain('Azure DevOps');
    click(l, 'settings:tree:board-team');
    expect(crumbs(l)).toBe('Abe › Board & you');
    const labels = settingRows(l).map((r) => r.props.label);

    expect(labels.slice(0, 3)).toEqual(['Provider', 'Project', 'Card types']);
    for (const azure of ['Organization', 'Board team', 'Your az login folder'])
      expect(labels).not.toContain(azure);
  });

  // a source's Sign in (ADR 0028): serve runs it, its row says Signing in…, then how it ended
  test.each<[string, SourcesData['sources'][number], string, string | undefined, string[][]]>([
    [
      'needs a sign-in: ⏎ signs in',
      {
        id: 'sentry',
        server: 'sentry',
        check: 'needs your sign-in',
        signIn: 'offered',
        reads: false,
      },
      'needs your sign-in',
      'Sign in…',
      [['source', 'sign-in', 'sentry']],
    ],
    [
      'serve signs in: ⏎ starts it again',
      { id: 'sentry', server: 'sentry', check: 'Signing in…', signIn: 'signing-in', reads: false },
      'Signing in…',
      'Sign in again…',
      [['source', 'sign-in', 'sentry']],
    ],
    [
      'signed in, its read ok: ⏎ says so',
      { id: 'sentry', server: 'sentry', check: 'Signed in · read OK', signIn: null, reads: true },
      '✓ Signed in · read OK',
      undefined,
      [],
    ],
    [
      'a failed sign-in: why, ⏎ signs in again',
      {
        id: 'sentry',
        server: 'sentry',
        check: 'sign-in failed: the browser closed',
        signIn: 'offered',
        reads: false,
      },
      'sign-in failed: the browser closed',
      'Sign in…',
      [['source', 'sign-in', 'sentry']],
    ],
  ])("a source's row: %s", (_, source, state, way, ran) => {
    const { l } = open();

    logins(l, { where: 'this Mac', tools: [] }, { repo: '/r/shop', sources: [source] });
    const row = checkRows(l).find((r) => r.props.label === 'sentry');

    expect([row?.props.check, row?.props.state.text, row?.props.way]).toEqual([
      'MCP server sentry',
      state,
      way,
    ]);
    // the source is the last row
    key(
      l,
      'ä',
      ...checkRows(l)
        .slice(1)
        .map(() => 'ö'),
    );
    expect(row !== undefined && checkRows(l).at(-1)?.props.focused).toBe(true);
    expect(runs(key(l, '<CR>')).map((c) => c.argv)).toEqual(ran);
  });

  test("a source's sign-in ending is told: its row as serve has it now, another checkout's not", () => {
    const { l } = open();
    const row = (check: string, signIn: 'offered' | 'signing-in' | null, reads: boolean) => ({
      id: 'sentry',
      server: 'sentry',
      check,
      signIn,
      reads,
    });

    logins(
      l,
      { where: 'this Mac', tools: [] },
      {
        repo: '/r/shop',
        sources: [row('Signing in…', 'signing-in', false)],
      },
    );
    const told = (repo: string) =>
      l.send({
        kind: 'event',
        event: {
          seq: 1,
          at: '2026-10-28T09:00:00.000Z',
          type: 'sources.changed',
          data: { repo, sources: [row('Signed in · read OK', null, true)] },
        },
      });

    told('/r/other');
    expect(checkRows(l).at(-1)?.props.state.text).toBe('Signing in…');
    told('/r/shop');
    expect(checkRows(l).at(-1)?.props.state.text).toBe('✓ Signed in · read OK');
  });

  test('each login and tool ends in ✓ OK or fix…, read when the page shows, once per open', () => {
    const { l } = open();

    logins(l);
    expect(crumbs(l)).toBe('Logins & tools');
    expect(
      checkRows(l).map((r) => [
        r.props.label,
        r.props.check,
        r.props.state.text,
        r.props.way ?? '',
      ]),
    ).toEqual([
      ['GitHub', 'gh auth status', '✓ OK', ''],
      ['Claude', 'claude auth status', '✓ OK', ''],
      [
        'Azure DevOps',
        'az account get-access-token',
        "⚠ sign in again: this checkout reads az's own folder (~/.azure)",
        'fix…',
      ],
      ['node', 'command -v node, as abe serve runs it', "⚠ not found on serve's PATH", 'fix…'],
      ['tmux', 'tmux -V', '✓ OK', ''],
    ]);
    expect(checkRows(l).find((r) => r.props.label === 'tmux')?.props.value).toBe('3.5a');
    // shown again: not read again this open
    click(l, 'settings:tree:appearance');
    expect(runs(click(l, 'settings:tree:logins-tools'))).toEqual([]);
  });

  test('a Mac without Docker: its row says it is optional, no warning, its install still a fix (#164)', () => {
    const { l } = open();

    logins(l, { where: 'this Mac', tools: [toolCheck('docker', { found: false }, false)] });
    expect(checkRows(l).find((r) => r.props.label === 'Docker')?.props).toMatchObject({
      state: {
        text: "○ not found on serve's PATH · optional: only the fake box and image builds need it",
      },
      way: 'fix…',
    });
    expect(checkRows(l).find((r) => r.props.label === 'Docker')?.props.state.tone).toBeUndefined();
  });

  test('⏎ types the fix into the strip; ⏎ again runs it in a terminal; its end checks again', () => {
    const { l } = open();

    logins(l);
    key(l, 'ä', 'ö', 'ö');
    expect(focused(l)).toBeUndefined();
    expect(checkRows(l)[2]?.props.focused).toBe(true);
    key(l, '<CR>');
    expect(fixOf(l)?.props).toMatchObject({
      title: 'fix · Azure DevOps',
      command: '$ az login --allow-no-subscriptions',
    });
    expect(fixOf(l)?.children).toEqual([]);
    expect(checkRows(l)[2]?.props.way).toBe('queued · ⏎ runs it');
    key(l, '<CR>');
    const term = fixOf(l)?.children[0];

    expect(term).toMatchObject({
      kind: 'Terminal',
      props: {
        argv: ['/bin/zsh', '-lc', 'az login --allow-no-subscriptions'],
        focused: true,
        screenKeys: ['<Esc>'],
      },
    });
    const termKey = term?.kind === 'Terminal' ? term.props.key : '';
    const again = l.send({ kind: 'exit', key: termKey, code: 0 });

    expect(fixOf(l)?.props.state).toBe('ended · checked again');
    // #345: each row says checking… until its read lands, never the answer from before the fix
    expect(checkRows(l)[2]?.props).toMatchObject({
      label: 'Azure DevOps',
      state: { text: 'checking…' },
      focused: true,
    });
    expect(runs(again).map((c) => c.argv)).toEqual([
      ['login', 'status'],
      ['tools', 'check'],
      ['source', 'status'],
      ['settings', 'problems'],
    ]);
    // Esc drops the strip and its terminal
    const dropped = key(l, '<Esc>');

    expect(fixOf(l)).toBeUndefined();
    expect(dropped).toContainEqual({
      kind: 'shell',
      effect: { kind: 'drop-terminal', key: termKey },
    });
    expect(l.tree?.kind).toBe('SettingsDialog');
  });

  test('a read refused keeps its rows, saying why, so the other read’s rows stay put (#345)', () => {
    const { l } = open();
    const asked = runs(click(l, 'settings:tree:logins-tools'));

    l.send({
      kind: 'result',
      id: asked[1]?.id ?? '',
      command: 'tools check',
      reply: { ok: true, data: { ...TOOLS, where: 'this box' } },
    });
    l.send({
      kind: 'result',
      id: asked[0]?.id ?? '',
      command: 'login status',
      reply: { ok: false, error: { code: 'no-logins', message: 'this abe serve keeps no logins' } },
    });
    const why = "⚠ can't check: this abe serve keeps no logins";

    expect(checkRows(l).map((r) => r.props.label)).toEqual([
      'GitHub',
      'Claude',
      'Azure DevOps',
      'node',
      'tmux',
    ]);
    expect(checkRows(l).map((r) => r.props.state.text)).toEqual([
      why,
      why,
      why,
      "⚠ not found on serve's PATH",
      '✓ OK',
    ]);
  });

  test('a login refusal first (no logins here) keeps every row; the page is not serve down (#345)', () => {
    const { l } = open();
    const asked = runs(click(l, 'settings:tree:logins-tools'));
    const scope = () => {
      const p = pageOf(l);

      return p?.kind === 'SettingsPage' ? p.props.scope : '';
    };

    l.send({
      kind: 'result',
      id: asked[0]?.id ?? '',
      command: 'login status',
      reply: { ok: false, error: { code: 'no-logins', message: 'this abe serve keeps no logins' } },
    });
    expect(checkRows(l).map((r) => r.props.state.text)).toEqual([
      "⚠ can't check: this abe serve keeps no logins",
      "⚠ can't check: this abe serve keeps no logins",
      "⚠ can't check: this abe serve keeps no logins",
      ...Array<string>(9).fill('checking…'),
    ]);
    l.send({
      kind: 'result',
      id: asked[1]?.id ?? '',
      command: 'tools check',
      reply: { ok: true, data: TOOLS },
    });
    noSources(l, asked);
    expect(scope()).toBe('this machine · checked when Settings opens');
  });

  test('serve down: the page says so', () => {
    const { l } = open();
    const asked = runs(click(l, 'settings:tree:logins-tools'));

    l.send({
      kind: 'result',
      id: asked[0]?.id ?? '',
      command: 'login status',
      reply: {
        ok: false,
        error: { code: 'serve-unreachable', message: 'abe serve is not answering' },
      },
    });
    expect(rows(l)[0]).toMatchObject({
      kind: 'SettingsEmpty',
      props: { title: 'abe serve not answering · Logins & tools read when it is back' },
    });
  });
});

const PROFILES: BrowserListData = {
  profiles: [
    {
      name: 'work',
      purpose: 'app user',
      layer: 'repo',
      default: false,
      storedAt: '2026-10-20T08:00:00Z',
      folder: true,
      open: false,
      storedAgo: '11 days ago',
      storeFailed: null,
    },
    {
      name: 'po-review',
      purpose: "product owner's login",
      layer: 'individual',
      default: false,
      storedAt: null,
      folder: true,
      open: true,
      storedAgo: null,
      storeFailed: null,
    },
    {
      name: 'default',
      purpose: 'empty · a fresh profile every start',
      layer: 'built-in',
      default: true,
      storedAt: null,
      folder: null,
      open: null,
      storedAgo: null,
      storeFailed: null,
    },
  ],
  unlisted: [],
  migrated: [],
  missingDefault: null,
};

/** Browser profiles shown, `browser list` answered. */
const profilesShown = (l: MountedLayer) => {
  const [list] = runs(click(l, 'settings:tree:browser-profiles'));

  expect(list?.argv).toEqual(['browser', 'list']);
  l.send({
    kind: 'result',
    id: list?.id ?? '',
    command: 'browser list',
    reply: { ok: true, data: PROFILES },
  });
};

const profilesTable = (l: MountedLayer): Table => {
  let found: Table | undefined;
  const walk = (n: Node) => {
    if (n.kind === 'Table') found = n;
    for (const c of kids(n)) walk(c);
  };

  walk(pageOf(l) ?? { kind: 'SettingsNote', props: { text: '' } });
  if (found === undefined) throw new Error('no profiles table');

  return found;
};

const writeAnswer = (
  id: string,
  command: 'browser add' | 'browser remove' | 'browser default',
  done: string,
): Input => ({
  kind: 'result',
  id,
  command,
  reply: { ok: true, data: { file: '/home/me/.config/abe/settings.yaml', done, list: PROFILES } },
});

describe('Browser profiles (#103 S4)', () => {
  test('the table: the repo’s, then yours, the built-in; where sign-ins live; the default marked', () => {
    const { l } = open();

    profilesShown(l);
    const t = profilesTable(l);

    expect(t.props.columns.map((c) => c.label)).toEqual([
      'Name',
      'Purpose',
      'Sign-ins',
      'Default',
      '',
    ]);
    expect(t.props.rows.map((r) => r.cells[0]?.text)).toEqual([
      'work',
      'po-review',
      'default',
      'Add profile…',
    ]);
    expect(t.props.rows.map((r) => [r.cells[2]?.text, r.cells[2]?.hue])).toEqual([
      ['stored 11 days ago', 'dim'],
      ['open now · not stored', 'accent'],
      ['none · a fresh profile every start', 'dim'],
      [undefined, undefined],
    ]);
    // Open on each profile with a folder to sign in to, a button of its own
    expect(t.props.rows.map((r) => r.cells[4]?.id)).toEqual([
      'settings:open:0',
      'settings:open:1',
      undefined,
      undefined,
    ]);
    expect(t.props.rows[2]?.cells[3]?.mark).toBe('●');
    // the default's own row follows the table
    expect(row(l, 'Default profile')).toBeDefined();
  });

  test('Space sets the default; ⌫ removes yours after y, the repo’s is refused', () => {
    const { l } = open();

    profilesShown(l);
    click(l, 'settings:line:0');
    const [def] = runs(key(l, '<Space>'));

    expect(def?.argv).toEqual(['browser', 'default', 'work']);
    expect(
      statusOf(l.send(writeAnswer(def?.id ?? '', 'browser default', 'default: work'))),
    ).toEqual(['default: work']);
    expect(statusOf(key(l, '<BS>'))[0]).toContain('repo demo-shop');
    click(l, 'settings:line:1');
    expect(runs(key(l, '<BS>'))).toEqual([]);
    expect(rows(l).length).toBeGreaterThan(0);
    const [rm] = runs(key(l, 'y'));

    expect(rm?.argv).toEqual(['browser', 'remove', 'po-review']);
  });

  test.each<{
    name: string;
    act: (l: MountedLayer) => Command[][];
    argv: string[] | null;
    said?: string;
  }>([
    {
      name: '⏎ opens its Chrome in front',
      act: (l) => [click(l, 'settings:line:0'), key(l, '<CR>')],
      argv: ['browser', 'open', 'work', '--front'],
    },
    {
      name: 'its Open button does the same on its row',
      act: (l) => [click(l, 'settings:open:1')],
      argv: ['browser', 'open', 'po-review', '--front'],
    },
    {
      name: 'the built-in has nothing to sign in to',
      act: (l) => [click(l, 'settings:line:2'), key(l, '<CR>')],
      argv: null,
      said: 'default is the built-in empty profile: nothing to sign in to',
    },
    {
      name: 'r renames yours in its row: the new name, ⏎',
      act: (l) => {
        click(l, 'settings:line:1');
        key(l, 'r');
        expect(profilesTable(l).props.rows[1]?.cells).toEqual([
          { text: 'Rename: po-review▏', hue: 'accent' },
        ]);
        key(l, ...Array.from('-review', () => '<BS>'));
        l.send({ kind: 'text', text: '-owner' });

        return [key(l, '<CR>')];
      },
      argv: ['browser', 'rename', 'po-review', 'po-owner'],
    },
    {
      name: 'the repo’s is not renamed here',
      act: (l) => [click(l, 'settings:line:0'), key(l, 'r')],
      argv: null,
      said: "work is repo demo-shop's: only yours are renamed here",
    },
  ])('$name', ({ act, argv, said }) => {
    const { l } = open();

    profilesShown(l);
    const outs = act(l);
    const ran = outs.flatMap(runs);

    expect(ran.map((c) => c.argv)).toEqual(argv === null ? [] : [argv]);
    if (said !== undefined) expect(outs.flatMap(statusOf)).toContain(said);
  });

  test('an answered Open, and its Chrome closing or storing, read the table again', () => {
    const { l } = open();

    profilesShown(l);
    const [opened] = runs(click(l, 'settings:open:0'));
    const answered = l.send({
      kind: 'result',
      id: opened?.id ?? '',
      command: 'browser open',
      reply: {
        ok: true,
        data: {
          name: 'work',
          folder: '/home/me/.config/abe/chrome/work',
          endpoint: 'http://127.0.0.1:9222',
          started: true,
          fronted: false,
        },
      },
    });

    expect(statusOf(answered)[0]).toStartWith("work's Chrome is open: sign in there");
    expect(runs(answered).map((c) => c.argv)).toEqual([['browser', 'list']]);
    const closed = l.send({
      kind: 'event',
      event: {
        seq: 2,
        at: '2026-10-31T09:00:00.000Z',
        type: 'browser.profile',
        data: { name: 'work', state: 'stored' },
      },
    });

    expect(runs(closed).map((c) => c.argv)).toEqual([['browser', 'list']]);
  });

  test('Add profile…: its name, ⏎, its purpose, ⏎ adds it to your Layer', () => {
    const { l } = open();

    profilesShown(l);
    click(l, 'settings:line:3');
    key(l, '<CR>');
    l.send({ kind: 'text', text: 'Q A' });
    key(l, '<CR>');
    expect(profilesTable(l).props.rows[3]?.cells[0]).toMatchObject({ hue: 'bad' });
    key(l, '<C-u>');
    l.send({ kind: 'text', text: 'qa' });
    key(l, '<CR>');
    l.send({ kind: 'text', text: 'tester' });
    const [add] = runs(key(l, '<CR>'));

    expect(add?.argv).toEqual(['browser', 'add', 'qa', '--purpose=tester']);
  });

  test('⌘⏎ on yours proposes the repo’s list with it added', () => {
    const { l } = open();

    profilesShown(l);
    click(l, 'settings:line:1');
    key(l, '<D-CR>');
    expect(popup(l).props).toMatchObject({
      title: 'Propose for repo demo-shop',
      label: 'Browser profiles',
      value: { kind: 'fixed', from: 'work', to: 'work, po-review' },
      focus: 'reason',
    });
    l.send({ kind: 'text', text: 'the PO reviews every story' });
    const [sent] = runs(key(l, '<CR>'));

    expect(sent?.argv).toEqual([
      'settings',
      'propose',
      'browser.profiles',
      JSON.stringify([
        { name: 'work', purpose: 'app user' },
        { name: 'po-review', purpose: "product owner's login" },
      ]),
      '--reason=the PO reviews every story',
    ]);
  });
});

const IMPORT: SettingsImportData = {
  source: 'vscode',
  files: [
    { path: '~/Library/Application Support/Code/User/settings.json', found: true, error: null },
  ],
  rows: [
    {
      id: 'editor.fontSize',
      group: 'settings',
      from: 'editor.fontSize: 14',
      to: { key: 'ui.font.editorSize', value: 14 },
      bind: null,
      note: null,
      ticked: true,
    },
    {
      id: 'workbench.colorTheme',
      group: 'theme',
      from: 'workbench.colorTheme: Dark Modern',
      to: { key: 'ui.theme', value: 'dark-modern' },
      bind: null,
      note: null,
      ticked: true,
    },
    {
      id: 'editor.minimap.enabled',
      group: 'settings',
      from: 'editor.minimap.enabled: false',
      to: null,
      bind: null,
      note: 'no match here',
      ticked: false,
    },
  ],
  file: '/home/me/.config/abe/settings.yaml',
  dryRun: true,
  written: [],
  keysFile: '~/.config/abe/keys.json',
  keysWritten: [],
  refused: [],
};

/** `abe local status`'s answer, or `local on|off`'s, for this checkout. */
const localAnswer = (
  id: string,
  command: 'local status' | 'local on' | 'local off',
  checkout: string | null,
  on: boolean,
): Input =>
  command === 'local status'
    ? {
        kind: 'result',
        id,
        command,
        reply: { ok: true, data: { checkout, on, held: [], prs: [], cards: [] } },
      }
    : { kind: 'result', id, command, reply: { ok: true, data: { checkout: checkout ?? '/', on } } };

/** Settings › Abe › Local mode shown, `abe local status` answered. */
const localShown = (l: MountedLayer, checkout: string | null = '/work/demo-shop', on = false) => {
  const [status] = runs(click(l, 'settings:tree:local-mode'));

  expect(status?.argv).toEqual(['local', 'status']);
  expect(row(l, 'Local mode').props.source.text).toBe('reading…');
  l.send(localAnswer(status?.id ?? '', 'local status', checkout, on));
};

describe('Local mode (#24, LM-Setting)', () => {
  test("the page: this checkout's name and yours, the checkbox, what it means, every checkout", () => {
    const { l } = open();

    localShown(l);
    const p = pageOf(l);

    expect(p?.kind === 'SettingsPage' ? [p.props.crumbs, p.props.scope] : undefined).toEqual([
      ['Abe', 'Local mode'],
      'demo-shop · yours',
    ]);
    expect(
      settingRows(l).map((r) => [r.props.label, r.props.control.kind, r.props.source.text]),
    ).toEqual([
      ['Local mode', 'checkbox', ''],
      ['Reads', 'value', ''],
      ['Writes, held', 'value', ''],
      ['Agents', 'value', ''],
      ['Turning it off', 'value', ''],
      ['Done', 'value', ''],
      ['Local mode checkouts', 'list', 'built-in'],
      ['Read-only board checkouts', 'list', 'built-in'],
    ]);
    expect(row(l, 'Local mode').props).toMatchObject({
      control: { on: false },
      help: 'Read the board, issues, PRs and CI; hold every write on this machine. For trying the Factory on a real repo.',
    });
    expect(row(l, 'Done').props.help).toBe(
      'a card is Done when its local pull request merges (there is no deploy to watch)',
    );
  });

  test('⏎ or Space turns it on or off at once; the answer ticks it and says so; a refusal too', () => {
    const { l } = open();

    localShown(l);
    click(l, 'settings:line:0');
    const [on] = runs(key(l, '<Space>'));

    expect(on?.argv).toEqual(['local', 'on']);
    expect(row(l, 'Local mode').props.source.text).toBe('writing…');
    expect(runs(key(l, '<Space>'))).toEqual([]);
    expect(
      statusOf(l.send(localAnswer(on?.id ?? '', 'local on', '/work/demo-shop', true))),
    ).toEqual(['Local mode on · demo-shop: every write held on this machine']);
    expect(row(l, 'Local mode').props.control).toEqual({ kind: 'checkbox', on: true });
    // written by `abe local`, never a change of yours to undo
    expect(dialog(l).props.undo).toBeUndefined();
    const [off] = runs(key(l, '<CR>'));

    expect(off?.argv).toEqual(['local', 'off']);
    expect(
      statusOf(
        l.send({
          kind: 'result',
          id: off?.id ?? '',
          command: 'local off',
          reply: { ok: false, error: { code: 'bad-layer-file', message: 'yours does not read' } },
        }),
      ),
    ).toEqual(['Local mode: yours does not read (bad-layer-file)']);
    expect(row(l, 'Local mode').props).toMatchObject({
      control: { on: true },
      source: { text: '' },
    });
    expect(statusOf(key(l, '<D-CR>'))).toEqual(['Local mode: yours alone, not for the repo']);
  });

  test('a write anywhere reads it again; outside a checkout it says so and ⏎ runs nothing', () => {
    const { l } = open();

    localShown(l, null);
    expect(row(l, 'Local mode').props.source.text).toBe(
      'not in a checkout: local mode is per checkout',
    );
    click(l, 'settings:line:0');
    expect(runs(key(l, '<CR>'))).toEqual([]);
    const again = l.send({
      kind: 'event',
      event: {
        seq: 1,
        at: '2026-10-26T09:00:00.000Z',
        type: 'settings.changed',
        data: { keys: ['localMode'], repo: null, files: ['settings.yaml'] },
      },
    });

    expect(runs(again).map((r) => r.argv)).toEqual([
      ['settings', 'list'],
      ['local', 'status'],
    ]);
  });
});

describe('Import config (#120)', () => {
  test('⏎ on a source reads what it would bring; Space unticks; Import writes only the ticked', () => {
    const { l } = open();

    click(l, 'settings:tree:import-config');
    key(l, 'ä');
    expect(settingRows(l).map((r) => r.props.label)).toEqual([
      'VS Code',
      'WebStorm',
      'Vim / Neovim',
    ]);
    const [dry] = runs(key(l, '<CR>'));

    // #153: a value before it is read, so the line below sits under one
    expect(row(l, 'WebStorm').props.control).toEqual({ kind: 'value', text: 'not read' });
    expect(dry?.argv).toEqual(['settings', 'import', 'vscode', '--dry-run']);
    expect(row(l, 'VS Code').props.control).toEqual({ kind: 'value', text: 'reading…' });
    l.send({
      kind: 'result',
      id: dry?.id ?? '',
      command: 'settings import',
      reply: { ok: true, data: IMPORT },
    });
    expect(row(l, 'VS Code').props.control).toEqual({
      kind: 'value',
      text: '2 of 3 settings match',
    });
    expect(row(l, 'editor.fontSize: 14').props).toMatchObject({
      control: { kind: 'checkbox', on: true },
      source: { text: '→ Editor font size = 14' },
    });
    expect(row(l, 'editor.minimap.enabled: false').props.control).toEqual({
      kind: 'checkbox',
      on: false,
      fixed: true,
    });
    // untick the theme, then Import
    key(l, 'ö', 'ö', 'ö', 'ö', '<Space>');
    expect(row(l, 'workbench.colorTheme: Dark Modern').props.control).toMatchObject({ on: false });
    key(l, 'ö', 'ö');
    expect(focused(l)).toMatchObject({
      props: {
        label: 'Import 1 setting',
        source: { text: 'into yours only; Problems shows what it refuses' },
      },
    });
    const [go] = runs(key(l, '<CR>'));

    expect(go?.argv).toEqual(['settings', 'import', 'vscode', '--only', 'ui.font.editorSize']);
    const done = l.send({
      kind: 'result',
      id: go?.id ?? '',
      command: 'settings import',
      reply: { ok: true, data: { ...IMPORT, dryRun: false, written: ['ui.font.editorSize'] } },
    });

    expect(statusOf(done)).toEqual(['1 setting imported into yours']);
    expect(runs(done).map((c) => c.argv)).toEqual([['settings', 'list']]);
  });
});

describe('Import config: an honest count (#153)', () => {
  const RICH: SettingsImportData = {
    ...IMPORT,
    rows: [
      {
        id: 'feel',
        group: 'feel',
        from: 'VS Code',
        to: { key: 'ui.feel', value: 'vscode' },
        bind: null,
        note: null,
        ticked: true,
      },
      ...IMPORT.rows,
      ...['cmd+p', 'cmd+b'].map((chord) => ({
        id: `keys:${chord}`,
        group: 'keys' as const,
        from: `${chord}: something`,
        to: null,
        bind: null,
        note: 'no match here: VimStorm has no something',
        ticked: false,
      })),
    ],
  };

  test('the Feel row and key bindings are no settings to match; the keys their own count', () => {
    const { l } = open();

    click(l, 'settings:tree:import-config');
    key(l, 'ä');
    const [dry] = runs(key(l, '<CR>'));

    l.send({
      kind: 'result',
      id: dry?.id ?? '',
      command: 'settings import',
      reply: { ok: true, data: RICH },
    });
    expect(row(l, 'VS Code').props.control).toEqual({
      kind: 'value',
      text: '2 of 3 settings match',
    });
    const brings = kids(pageOf(l)).find(
      (g) => g.kind === 'SettingsGroup' && g.props.caption === 'What it brings',
    );

    expect(brings?.kind === 'SettingsGroup' ? brings.props.note : undefined).toBe(
      'ticked: a match here · 0 of 2 keys match a Keymap action',
    );
    // the Feel's row is a setting Import writes: three of them, each once
    key(l, 'ö', 'ö', 'ö', 'ö', 'ö', 'ö', 'ö', 'ö', 'ö');
    expect(focused(l)).toMatchObject({ props: { label: 'Import 3 settings' } });
  });

  // #129: a key on one of the Keymap's actions is a match Import writes to your keys.json
  test('a matched key binding ticks, and Import names it key:<the key>', () => {
    const { l } = open();
    const KEYS: SettingsImportData = {
      ...IMPORT,
      rows: [
        {
          id: 'keys:cmd+y:workbench.action.quickOpen',
          group: 'keys',
          from: 'cmd+y → workbench.action.quickOpen',
          to: null,
          bind: { key: '⌘Y', action: 'goToFile' },
          note: null,
          ticked: true,
        },
        {
          id: 'keys:cmd+k cmd+t:x',
          group: 'keys',
          from: 'cmd+k cmd+t → x',
          to: null,
          bind: null,
          note: 'no match here: a two-key chord (VimStorm binds one key)',
          ticked: false,
        },
      ],
    };

    click(l, 'settings:tree:import-config');
    key(l, 'ä');
    const [dry] = runs(key(l, '<CR>'));

    l.send({
      kind: 'result',
      id: dry?.id ?? '',
      command: 'settings import',
      reply: { ok: true, data: KEYS },
    });
    expect(row(l, 'cmd+y → workbench.action.quickOpen').props).toMatchObject({
      control: { kind: 'checkbox', on: true },
      source: { text: '→ ⌘Y = Go to File' },
    });
    expect(row(l, 'cmd+k cmd+t → x').props.control).toMatchObject({ on: false, fixed: true });
    key(l, 'ö', 'ö', 'ö', 'ö', 'ö');
    expect(focused(l)).toMatchObject({
      props: {
        label: 'Import 1 key',
        source: { text: 'into yours only, keys into keys.json; Problems shows what it refuses' },
      },
    });
    const [go] = runs(key(l, '<CR>'));

    expect(go?.argv).toEqual(['settings', 'import', 'vscode', '--only', 'key:⌘Y']);
    const done = l.send({
      kind: 'result',
      id: go?.id ?? '',
      command: 'settings import',
      reply: { ok: true, data: { ...KEYS, dryRun: false, keysWritten: ['⌘Y'] } },
    });

    expect(statusOf(done)).toEqual(['0 settings imported into yours · 1 key into keys.json']);
  });
});

describe('review fixes (M4 milestone review)', () => {
  test('typed text is never read as a flag: inline flag values, positionals after --', () => {
    expect(cliArgv(['settings', 'set'], ['setup', '-x'], ['--mine'])).toEqual([
      'settings',
      'set',
      '--mine',
      '--',
      'setup',
      '-x',
    ]);
    const { l } = open();

    at(l, 'boxes-cloud', 'Largest disk');
    key(l, '<D-CR>', '<Tab>');
    l.send({ kind: 'text', text: '--json' });
    const [sent] = runs(key(l, '<CR>'));

    expect(sent?.argv.at(-1)).toBe('--reason=--json');
  });

  test('closing the dialog lets a running fix go at once', () => {
    const { l } = open();

    logins(l);
    key(l, 'ä', 'ö', 'ö', '<CR>', '<CR>');
    const term = fixOf(l)?.children[0];
    const termKey = term?.kind === 'Terminal' ? term.props.key : '';

    expect(termKey).not.toBe('');
    const closing = click(l, 'settings:close');

    expect(l.tree).toBeUndefined();
    expect(closing).toContainEqual({
      kind: 'shell',
      effect: { kind: 'drop-terminal', key: termKey },
    });
  });

  test('a page read answered after close is dropped: the next open reads it again', () => {
    const { l } = open();
    const asked = runs(click(l, 'settings:tree:logins-tools'));

    click(l, 'settings:close');
    l.send({
      kind: 'result',
      id: asked[0]?.id ?? '',
      command: 'login status',
      reply: { ok: true, data: LOGINS },
    });
    const again = runs(l.send({ kind: 'open', params: { page: 'logins-tools' }, size: SIZE }));

    expect(again.map((c) => c.argv)).toContainEqual(['login', 'status']);
  });

  test('Retry after serve was down reads Logins & tools again', () => {
    const { l } = open();
    const [first] = runs(click(l, 'settings:tree:logins-tools'));

    l.send({
      kind: 'result',
      id: first?.id ?? '',
      command: 'login status',
      reply: {
        ok: false,
        error: { code: 'serve-unreachable', message: 'abe serve is not answering' },
      },
    });
    const retried = runs(click(l, 'settings:retry'));

    expect(retried.map((c) => c.argv)).toContainEqual(['login', 'status']);
  });

  test('a tree click leaves Add profile… and its keys', () => {
    const { l } = open();

    profilesShown(l);
    click(l, 'settings:line:3');
    key(l, '<CR>');
    click(l, 'settings:tree:appearance');
    expect(crumbs(l)).toContain('Appearance');
    // ö moves again: no field holds the keys
    key(l, 'ä', 'ö');
    expect(focused(l)).toBeDefined();
  });

  test('Esc leaves a proposal while it opens', () => {
    const { l } = open();

    at(l, 'boxes-cloud', 'Largest disk');
    key(l, '<D-CR>', '<Tab>');
    l.send({ kind: 'text', text: 'why' });
    key(l, '<CR>');
    key(l, '<Esc>');
    expect(dialog(l).children.some((c) => c.kind === 'SettingsPropose')).toBe(false);
  });
});

describe('abe serve not answering', () => {
  test('the tree still shows, the page says so, Retry reads again', () => {
    const l = mountLayer(settingsLayer(SETTINGS_RULES));

    l.send({ kind: 'open', params: {}, size: SIZE });
    const down = { ok: false as const, error: { code: 'serve-unreachable', message: 'no serve' } };

    l.send({ kind: 'result', id: 'settings:list:1', command: 'settings list', reply: down });
    l.send({
      kind: 'result',
      id: 'settings:problems:2',
      command: 'settings problems',
      reply: down,
    });
    expect(treeRows(l).map((r) => r.label)).toContain('Appearance');
    expect(rows(l)).toEqual([
      {
        kind: 'SettingsEmpty',
        props: {
          title: 'abe serve not answering · Settings read when it is back',
          action: { id: 'settings:retry', label: 'Retry' },
        },
      },
    ]);
    expect(runs(click(l, 'settings:retry')).map((r) => r.argv)).toEqual([
      ['settings', 'list', '--files-only'],
      ['settings', 'list'],
      ['settings', 'problems', '--files-only'],
      ['settings', 'problems'],
    ]);
  });

  test('serve back: it reads again by itself', () => {
    const l = mountLayer(settingsLayer(SETTINGS_RULES));

    l.send({ kind: 'open', params: {}, size: SIZE });
    l.send({
      kind: 'result',
      id: 'settings:list:1',
      command: 'settings list',
      reply: { ok: false, error: { code: 'serve-unreachable', message: 'no serve' } },
    });
    const again = l.send({
      kind: 'event',
      event: {
        seq: 1,
        at: '2026-10-25T05:00:00.000Z',
        type: 'serve.started',
        data: { pid: 1, version: '2.1.0', socket: '/s' },
      },
    });

    expect(runs(again).map((r) => r.argv)).toEqual([
      ['settings', 'list', '--files-only'],
      ['settings', 'list'],
      ['settings', 'problems', '--files-only'],
      ['settings', 'problems'],
    ]);
  });
});

/** `abe theme list` over the built-ins, Islands Dark current. */
const themeListAnswer = (id: string): Input => ({
  kind: 'result',
  id,
  command: 'theme list',
  reply: {
    ok: true,
    data: { themes: themeCatalogue([]).map((t) => themeRow(t, 'islands-dark')), problems: [] },
  },
});

const themeRead = (cs: readonly Command[]) =>
  runs(cs).filter((r) => r.argv.join(' ') === 'theme list');

const looks = (cs: readonly Command[]) => cs.flatMap((c) => (c.kind === 'look' ? [c.stage] : []));

describe('Appearance: the theme list, live at once (#108 S4, T-Appearance)', () => {
  test('its page reads abe theme list once; each theme a preview cell in its own colours', () => {
    const { l, first } = open();
    const read = themeRead(first);

    expect(read.map((r) => r.argv)).toEqual([['theme', 'list']]);
    expect(runs(click(l, 'settings:tree:appearance'))).toEqual([]);
    l.send(themeListAnswer(read[0]?.id ?? ''));
    const control = row(l, 'Theme').props.control;

    if (control.kind !== 'themes') throw new Error(`a ${control.kind}`);
    expect(control.on).toBe('islands-dark');
    expect(control.themes.map((t) => [t.name, t.source])).toEqual([
      ['Islands Dark', 'current'],
      ['Islands Light', ''],
      ['Dark Modern', ''],
    ]);
    expect(control.themes[1]?.colors).toMatchObject({ frame: '#ebecf0', editor: '#ffffff' });
  });

  test('⏎, ä, ⏎ saves Islands Light, live in every window until the rows read it back', () => {
    const { l, first } = open();

    l.send(themeListAnswer(themeRead(first)[0]?.id ?? ''));
    click(l, 'settings:tree:appearance');
    click(l, row(l, 'Theme').id ?? '');
    expect(looks(key(l, '<CR>', 'ä'))).toEqual([]);
    expect(row(l, 'Theme').props.control).toMatchObject({ kind: 'themes', cursor: 1 });
    const picked = key(l, '<CR>');
    const [theme] = runs(picked);

    expect(theme?.argv).toEqual(['settings', 'set', 'ui.theme', 'islands-light']);
    expect(looks(picked)).toEqual([{ theme: 'islands-light' }]);
    expect(row(l, 'Theme').props).toMatchObject({
      control: { kind: 'themes', on: 'islands-light' },
      changed: true,
    });
    // a second change keeps the theme in the look
    at(l, 'appearance', 'Density');
    const density = key(l, '<CR>', 'ä', '<CR>');

    expect(looks(density)).toEqual([{ theme: 'islands-light', density: 'default' }]);
    l.send(setAnswer(theme?.id ?? '', 'ui.theme', 'islands-light'));
    const [read] = runs(l.send(setAnswer(runs(density)[0]?.id ?? '', 'ui.density', 'default')));

    // both saved and read back: the look in force is theirs
    expect(looks(l.send(settingsListAnswer(read?.id ?? '', settingsList())))).toEqual([null]);
  });
});

describe('one home per setting (#345): the editor scheme on Color scheme, links elsewhere', () => {
  test('Color scheme’s Scheme: Same as theme (the theme shown), then each theme; a pick is live', () => {
    const { l, first } = open();

    l.send(themeListAnswer(themeRead(first)[0]?.id ?? ''));
    at(l, 'color-scheme', 'Scheme');
    expect(row(l, 'Scheme').props).toMatchObject({
      control: { kind: 'combo', value: 'Same as theme (Islands Dark)' },
      help: 'Same as theme follows Appearance › Theme; a named one stays when the theme changes',
      source: { text: '' },
    });
    key(l, '<CR>');
    const control = row(l, 'Scheme').props.control;

    if (control.kind !== 'combo') throw new Error(`a ${control.kind}`);
    expect(control.open?.choices.map((c) => c.text)).toEqual([
      'Same as theme (Islands Dark)',
      'Islands Dark',
      'Islands Light',
      'Dark Modern',
    ]);
    // Darcula's editor on whatever theme: the look names the scheme alone
    const picked = key(l, '<Down>', '<CR>');

    expect(looks(picked)).toEqual([{ scheme: 'islands-dark' }]);
    expect(row(l, 'Scheme').props).toMatchObject({
      control: { kind: 'combo', value: 'Islands Dark' },
      changed: true,
    });
    expect(runs(picked).map((w) => w.argv)).toEqual([
      ['settings', 'set', 'editor.scheme', 'islands-dark'],
    ]);
  });

  test('Appearance links to the editor font and the scheme: their values, ⏎ goes to their home', () => {
    const { l, first } = open({}, CLEAN_LAYERS, false);

    l.send(themeListAnswer(themeRead(first)[0]?.id ?? ''));
    expect(at(l, 'appearance', 'Editor font').props).toMatchObject({
      control: { kind: 'value', text: 'JetBrains Mono 13' },
      help: 'Editor › Font',
      source: { text: '' },
      hint: '⏎ go there',
    });
    key(l, '<CR>');
    expect(crumbs(l)).toBe('Editor › Font');
    expect(focused(l)).toMatchObject({
      props: { label: 'Editor font', control: { kind: 'combo' } },
    });
    expect(at(l, 'appearance', 'Editor scheme').props.control).toEqual({
      kind: 'value',
      text: 'Same as theme (Islands Dark)',
    });
    key(l, '<CR>');
    expect(crumbs(l)).toBe('Editor › Color scheme');
    expect(focused(l)).toMatchObject({ props: { label: 'Scheme' } });
    // no second control for the same setting anywhere: Appearance has no editor font row
    click(l, 'settings:tree:appearance');
    expect(
      settingRows(l)
        .filter((r) => r.props.label === 'Editor font')
        .map((r) => r.props.control.kind),
    ).toEqual(['value']);
  });

  test('a theme picked shows in Same as theme’s words at once', () => {
    const { l, first } = open();

    l.send(themeListAnswer(themeRead(first)[0]?.id ?? ''));
    at(l, 'appearance', 'Theme');
    key(l, '<CR>', 'ä', '<CR>');
    expect(row(l, 'Editor scheme').props.control).toEqual({
      kind: 'value',
      text: 'Same as theme (Islands Light)',
    });
  });

  test('the themes answering before the rows: Colours wait for both, then read the scheme’s', () => {
    const layers = CLEAN_LAYERS.map((x): LayerSource =>
      x.place === 'machine' && 'doc' in x
        ? {
            ...x,
            doc: {
              ...(typeof x.doc === 'object' && x.doc !== null ? x.doc : {}),
              editor: { scheme: 'islands-light' },
            },
          }
        : x,
    );
    const l = mountLayer(settingsLayer(SETTINGS_RULES));
    const first = l.send({ kind: 'open', params: { page: 'color-scheme' }, size: SIZE });

    expect(runs(l.send(themeListAnswer(themeRead(first)[0]?.id ?? '')))).toEqual([]);
    const show = runs(l.send(settingsListAnswer('settings:list:1', settingsList(layers))));

    expect(show.map((r) => r.argv)).toEqual([['theme', 'show', 'islands-light']]);
    // an older read's answer is no answer
    expect(runs(l.send(themeShowAnswer('settings:colours:0')))).toEqual([]);
    expect(rows(l).some((n) => n.kind === 'SettingRow' && n.props.label === 'Filter')).toBe(false);
  });

  test('a scheme found by `/` names its theme as the page does', () => {
    // opened on Vim: no page of it read the themes
    const { l } = open({ page: 'vim' }, CLEAN_LAYERS, false);

    key(l, '/');
    const read = themeRead(l.send({ kind: 'text', text: 'scheme' }));

    expect(read).toHaveLength(1);
    l.send(themeListAnswer(read[0]?.id ?? ''));
    expect(row(l, 'Scheme').props.control).toEqual({
      kind: 'combo',
      value: 'Same as theme (Islands Dark)',
    });
  });

  test('with a named scheme Colours edit its editor, git, diff and terminal colours; a save sets the scheme', () => {
    const layers = CLEAN_LAYERS.map((x): LayerSource =>
      x.place === 'machine' && 'doc' in x
        ? {
            ...x,
            doc: {
              ...(typeof x.doc === 'object' && x.doc !== null ? x.doc : {}),
              editor: { scheme: 'islands-light' },
            },
          }
        : x,
    );
    const { l, first } = open({}, layers, false);
    const show = runs(l.send(themeListAnswer(themeRead(first)[0]?.id ?? '')));

    expect(show.map((r) => r.argv)).toEqual([['theme', 'show', 'islands-light']]);
    const light = themeCatalogue([]).find((t) => t.slug === 'islands-light');

    if (light === undefined) throw new Error('no Islands Light');
    l.send({
      kind: 'result',
      id: show[0]?.id ?? '',
      command: 'theme show',
      reply: {
        ok: true,
        data: { theme: themeRow(light, 'islands-dark'), groups: themeGroups(light) },
      },
    });
    click(l, 'settings:tree:color-scheme');
    expect(groupsOf(l).map((g) => g.head)).toEqual([
      '▸ Editor · 71 tokens',
      '▸ Git · 17 tokens',
      '▸ Diff · 20 tokens',
      '▸ Terminal · 20 tokens',
    ]);
    at(l, 'color-scheme', 'Filter');
    key(l, '<CR>');
    l.send({ kind: 'text', text: 'editor-bg' });
    key(l, '<CR>', 'ö', 'ö', '<CR>', ...Array.from({ length: 7 }, () => '<BS>'));
    expect(looks(l.send({ kind: 'text', text: '#fafafa' }))).toEqual([
      { tokens: { 'editor-bg': '#fafafa' } },
    ]);
    const [save] = runs(key(l, '<CR>'));

    expect(save?.argv.slice(0, 3)).toEqual(['theme', 'save', 'islands-light']);
    const sets = runs(
      l.send({
        kind: 'result',
        id: save?.id ?? '',
        command: 'theme save',
        reply: {
          ok: true,
          data: {
            slug: 'islands-light-yours',
            name: 'Islands Light (yours)',
            file: '/c/themes/islands-light-yours.json',
            tokens: { 'editor-bg': '#fafafa' },
            replaced: null,
          },
        },
      }),
    );

    expect(sets.map((r) => r.argv)).toEqual([
      ['settings', 'set', 'editor.scheme', 'islands-light-yours'],
    ]);
  });
});

/** `abe theme show islands-dark`: every token by group. */
const themeShowAnswer = (id: string): Input => {
  const dark = themeCatalogue([]).find((t) => t.slug === 'islands-dark');

  if (dark === undefined) throw new Error('no Islands Dark');

  return {
    kind: 'result',
    id,
    command: 'theme show',
    reply: { ok: true, data: { theme: themeRow(dark, 'islands-dark'), groups: themeGroups(dark) } },
  };
};

/** Appearance with its themes and Colours read. */
const colours = (): MountedLayer => {
  const { l, first } = open();
  const read = l.send(themeListAnswer(themeRead(first)[0]?.id ?? ''));
  const show = runs(read);

  expect(show.map((r) => r.argv)).toEqual([['theme', 'show', 'islands-dark']]);
  l.send(themeShowAnswer(show[0]?.id ?? ''));
  click(l, 'settings:tree:color-scheme');

  return l;
};

/** Each token group: its head row's label and value, and how many tokens show under it. */
const groupsOf = (l: MountedLayer) =>
  kids(pageOf(l)).flatMap((g) => {
    if (g.kind !== 'SettingsGroup' || g.id?.startsWith('settings:colours:') !== true) return [];
    const [head, ...tokens] = kids(g);

    return head?.kind === 'SettingRow' && head.props.control.kind === 'value'
      ? [{ head: `${head.props.label} · ${head.props.control.text}`, rows: tokens.length }]
      : [];
  });

describe('Colours: the 260 tokens, live while changed (#108 S4, T-Colours)', () => {
  test('`/` finds a token too (#345): its row on Editor › Color scheme, ⏎ its colour field', () => {
    const l = colours();

    key(l, '/');
    l.send({ kind: 'text', text: 'needs-you' });
    const found = settingRows(l).find((r) => r.props.label === 'abe-needs-you');

    expect(found?.props.control).toMatchObject({ kind: 'colour', hex: '#5ec8c0' });
    expect(
      kids(pageOf(l)).flatMap((g) => (g.kind === 'SettingsGroup' ? [g.props.caption] : [])),
    ).toContain('Color scheme');
    key(l, '<CR>');
    while (focused(l)?.kind === 'SettingRow' && row(l, 'abe-needs-you').props.focused !== true)
      key(l, 'ö');
    key(l, '<CR>');
    expect(row(l, 'abe-needs-you').props.control).toMatchObject({ kind: 'colour', editing: true });
  });

  test('Color scheme picked while searching: the found token shows, marked, its group open, the filter aside (#345)', () => {
    const l = colours();

    // a filter left from an earlier visit that hides it
    at(l, 'color-scheme', 'Filter');
    key(l, '<CR>');
    l.send({ kind: 'text', text: 'editor' });
    key(l, '<CR>');
    expect(settingRows(l).some((r) => r.props.label === 'abe-needs-you')).toBe(false);
    key(l, '/');
    l.send({ kind: 'text', text: 'needs-you' });
    click(l, 'settings:tree:color-scheme');
    expect(row(l, 'abe-needs-you').props.hit).toBe(true);
    // and `scheme` finds the Scheme row, not 260 tokens
    key(l, '/', '<C-u>');
    l.send({ kind: 'text', text: 'scheme' });
    expect(settingRows(l).filter((r) => r.props.control.kind === 'colour')).toEqual([]);
  });

  test('a search on a page with no themes reads them, for the tokens it finds (#345)', () => {
    const { l } = open({ page: 'agents' });
    const typed = [...key(l, '/'), ...l.send({ kind: 'text', text: 'needs' })];

    expect(themeRead(typed)).toHaveLength(1);
  });

  test('six groups folded with their counts, last on the page; filtering `needs` leaves one row', () => {
    const l = colours();

    expect(groupsOf(l)).toEqual([
      { head: '▸ Chrome · 125 tokens', rows: 0 },
      { head: '▸ Editor · 71 tokens', rows: 0 },
      { head: '▸ Abe status · 7 tokens', rows: 0 },
      { head: '▸ Git · 17 tokens', rows: 0 },
      { head: '▸ Diff · 20 tokens', rows: 0 },
      { head: '▸ Terminal · 20 tokens', rows: 0 },
    ]);
    // nothing after Colours: its rows landing late move nothing above them (#297)
    expect(settingRows(l).at(-1)?.props.label).toBe('▸ Terminal');
    expect(row(l, 'Filter').props.source.text).toBe('260 in 6 groups');
    at(l, 'color-scheme', 'Filter');
    key(l, '<CR>');
    l.send({ kind: 'text', text: 'needs' });
    expect(groupsOf(l)).toEqual([{ head: '▾ Abe status · 7 tokens', rows: 1 }]);
    expect(row(l, 'Filter').props.source.text).toBe('1 token matches · 260 in 6 groups');
    expect(row(l, 'abe-needs-you').props.control).toEqual({ kind: 'colour', hex: '#5ec8c0' });
    // the usage in words, its source references left out
    expect(row(l, 'abe-needs-you').props.help).toBe(
      'Needs you only: workspace dots, the overflow count, status words and badges. Never red, never shared with Running.',
    );
  });

  test('⏎ or ä opens a group, k on it or a token folds it (#300)', () => {
    const l = colours();

    at(l, 'color-scheme', 'Filter');
    key(l, 'ö', 'ö', 'ö');
    expect(row(l, '▸ Abe status').props).toMatchObject({ focused: true, hint: '⏎ shows them' });
    key(l, '<CR>');
    expect(groupsOf(l)[2]).toEqual({ head: '▾ Abe status · 7 tokens', rows: 7 });
    key(l, 'ö', 'ö');
    expect(row(l, 'abe-bad').props.focused).toBe(true);
    key(l, 'k');
    expect(groupsOf(l)[2]).toEqual({ head: '▸ Abe status · 7 tokens', rows: 0 });
    expect(row(l, '▸ Abe status').props.focused).toBe(true);
    key(l, 'ä');
    expect(groupsOf(l)[2]?.rows).toBe(7);
    key(l, 'k');
    expect(groupsOf(l)[2]?.rows).toBe(0);
    expect(dialog(l).props.focus).toBe('page');
    // a folded head's k is the tree's, as on any row
    key(l, 'k');
    expect(dialog(l).props.focus).toBe('tree');
  });

  test('a hex typed is live; ⏎ saves yours at once with only that token and makes it the theme', () => {
    const l = colours();

    at(l, 'color-scheme', 'Filter');
    key(l, '<CR>');
    l.send({ kind: 'text', text: 'needs' });
    key(l, '<CR>', 'ö', 'ö', '<CR>');
    expect(row(l, 'abe-needs-you').props.control).toMatchObject({ editing: true, text: '#5ec8c0' });
    key(l, ...Array.from({ length: 7 }, () => '<BS>'));
    const live = l.send({ kind: 'text', text: '#a979f7' });

    expect(looks(live)).toEqual([{ tokens: { 'abe-needs-you': '#a979f7' } }]);
    const save = runs(key(l, '<CR>'));

    expect(row(l, 'abe-needs-you').props).toMatchObject({
      control: { kind: 'colour', hex: '#a979f7' },
      source: { text: 'was #5ec8c0' },
      changed: true,
    });
    expect(dialog(l).props.note).toBe('Saving 1 change…');
    expect(save.map((r) => r.argv)).toEqual([
      ['theme', 'save', 'islands-dark', '--tokens', '{"abe-needs-you":"#a979f7"}', '--replace'],
    ]);
    const answered = l.send({
      kind: 'result',
      id: save[0]?.id ?? '',
      command: 'theme save',
      reply: {
        ok: true,
        data: {
          slug: 'islands-dark-yours',
          name: 'Islands Dark (yours)',
          file: '/home/me/.config/abe/themes/islands-dark-yours.json',
          tokens: { 'abe-needs-you': '#a979f7' },
          replaced: { name: 'Islands Dark (yours)', changed: 3 },
        },
      },
    });
    const set = runs(answered);

    // #177: a theme of yours written over is said
    expect(statusOf(answered)).toContain(
      'Colours saved as Islands Dark (yours), replacing your earlier one',
    );
    expect(set.map((r) => r.argv)).toEqual([['settings', 'set', 'ui.theme', 'islands-dark-yours']]);
    const done = l.send(setAnswer(set[0]?.id ?? '', 'ui.theme', 'islands-dark-yours'));

    // the dialog stays, the colours live over the theme read; ⌘Z offered
    expect(statusOf(done)).toEqual(['Saved abe-needs-you']);
    expect(dialog(l).props.undo).toEqual({ id: 'settings:undo', label: 'Undo' });
    expect(looks(done)).toEqual([]);
    // ⌘Z saves the token back at the theme's own colour
    expect(runs(key(l, '<D-z>')).map((r) => r.argv)).toEqual([
      ['theme', 'save', 'islands-dark', '--tokens', '{"abe-needs-you":"#5ec8c0"}', '--replace'],
    ]);
  });

  test('Esc puts a colour field back; ⌫ saves a changed token back; Close keeps what was saved', () => {
    const l = colours();

    at(l, 'color-scheme', 'Filter');
    key(l, '<CR>');
    l.send({ kind: 'text', text: 'needs' });
    key(l, '<CR>', 'ö', 'ö', '<CR>', ...Array.from({ length: 7 }, () => '<BS>'));
    l.send({ kind: 'text', text: '#a979f7' });
    expect(looks(key(l, '<Esc>'))).toEqual([null]);
    key(l, '<CR>', ...Array.from({ length: 7 }, () => '<BS>'));
    l.send({ kind: 'text', text: '#a979f7' });
    key(l, '<CR>');
    const back = key(l, '<BS>');

    expect(runs(back).map((r) => r.argv)).toEqual([
      ['theme', 'save', 'islands-dark', '--tokens', '{"abe-needs-you":"#5ec8c0"}', '--replace'],
    ]);
    expect(row(l, 'abe-needs-you').props.changed).toBeUndefined();
    expect(looks(click(l, 'settings:close'))).toEqual([null]);
    expect(l.tree).toBeUndefined();
  });

  test('a theme save refused keeps the colours live and the dialog open, and says why', () => {
    const l = colours();

    at(l, 'color-scheme', 'Filter');
    key(l, '<CR>');
    l.send({ kind: 'text', text: 'needs' });
    key(l, '<CR>', 'ö', 'ö', '<CR>', ...Array.from({ length: 7 }, () => '<BS>'));
    l.send({ kind: 'text', text: '#a979f7' });
    const save = runs(key(l, '<D-s>'));
    const refused = l.send({
      kind: 'result',
      id: save[0]?.id ?? '',
      command: 'theme save',
      reply: { ok: false, error: { code: 'bad-theme', message: 'no such theme' } },
    });

    expect(l.tree).toBeDefined();
    expect(statusOf(refused)[0]).toContain('Colours not saved');
    expect(row(l, 'abe-needs-you').props.changed).toBe(true);
    expect(row(l, 'Filter').props.error).toContain('Colours not saved');
    expect(dialog(l).props.undo).toBeUndefined();
  });

  test('Close with a colour field open puts its hex back: nothing saved', () => {
    const l = colours();

    at(l, 'color-scheme', 'Filter');
    key(l, '<CR>');
    l.send({ kind: 'text', text: 'needs' });
    key(l, '<CR>', 'ö', 'ö', '<CR>', ...Array.from({ length: 7 }, () => '<BS>'));
    l.send({ kind: 'text', text: '#a979f7' });
    // ⌘, again while it is open: the field closes with its old hex back
    l.send({ kind: 'open', params: {}, size: SIZE });
    click(l, 'settings:tree:color-scheme');
    click(l, row(l, 'abe-needs-you').id ?? '');
    click(l, row(l, 'abe-needs-you').id ?? '');
    key(l, ...Array.from({ length: 7 }, () => '<BS>'));
    l.send({ kind: 'text', text: '#a979f7' });
    const closing = click(l, 'settings:close');

    expect(looks(closing)).toEqual([null]);
    expect(runs(closing)).toEqual([]);
    expect(l.tree).toBeUndefined();
  });

  test('a colour edit while a theme pick saves is refused: Colours edit the theme in force', () => {
    const l = colours();

    at(l, 'appearance', 'Theme');
    key(l, '<CR>', 'ä', '<CR>');
    at(l, 'color-scheme', 'Filter');
    key(l, '<CR>');
    l.send({ kind: 'text', text: 'needs' });
    const refused = key(l, '<CR>', 'ö', 'ö', '<CR>');

    expect(statusOf(refused)).toEqual([
      'Colours edit Islands Dark, the theme in force: the theme picked is still saving',
    ]);
    expect(row(l, 'abe-needs-you').props.control).toEqual({ kind: 'colour', hex: '#5ec8c0' });
  });
});

describe('a field refused keeps what was typed, in plain words (#298)', () => {
  test('an empty Tab limit is no limit, written as null', () => {
    const { l } = open();

    at(l, 'editor-general', 'Tab limit');
    expect(runs(key(l, '<CR>', '<D-a>', '<BS>', '<CR>')).map((w) => w.argv)).toEqual([
      ['settings', 'set', 'tabs.limit', 'null'],
    ]);
    expect(row(l, 'Tab limit').props).toMatchObject({
      control: { kind: 'field', text: '' },
      source: { text: 'yours · saving…' },
      changed: true,
    });
    expect(row(l, 'Tab limit').props.error).toBeUndefined();
    // the field again: empty, not `null`
    key(l, '<CR>');
    expect(row(l, 'Tab limit').props.control).toEqual({
      kind: 'field',
      text: '',
      editing: true,
      size: 'number',
    });
    expect(runs(key(l, '<Esc>'))).toEqual([]);
  });

  test('a refused value stays in the open field with what it takes; typing lets the words go', () => {
    const { l } = open();

    at(l, 'editor-general', 'Tab limit');
    key(l, '<CR>', '<D-a>', '5', '0', '0', '<CR>');
    expect(row(l, 'Tab limit').props).toMatchObject({
      control: { kind: 'field', text: '500', editing: true },
      error: 'Needs a whole number from 1 to 100, or empty',
    });
    key(l, '<BS>');
    expect(row(l, 'Tab limit').props.error).toBeUndefined();
    expect(row(l, 'Tab limit').props.control).toMatchObject({ text: '50', editing: true });
    // Esc puts the value back and its words go with it
    key(l, '0', '<CR>');
    expect(row(l, 'Tab limit').props.error).toBeDefined();
    key(l, '<Esc>');
    expect(row(l, 'Tab limit').props.error).toBeUndefined();
    expect(row(l, 'Tab limit').props.control).toEqual({
      kind: 'field',
      text: '10',
      size: 'number',
    });

    at(l, 'appearance', 'UI font size');
    key(l, '<CR>', '<D-a>', '1', '0', '0', '<CR>');
    expect(row(l, 'UI font size').props).toMatchObject({
      control: { kind: 'field', text: '100', editing: true },
      error: 'Needs a whole number from 9 to 24',
    });
    // ⌘S with it refused keeps the field open, nothing written
    expect(runs(key(l, '<D-s>'))).toEqual([]);
    expect(row(l, 'UI font size').props.control).toMatchObject({ editing: true });
    l.send({ kind: 'text', text: '' });
    key(l, '<D-a>', '1', '4', '<CR>');
    expect(row(l, 'UI font size').props).toMatchObject({ changed: true, control: { text: '14' } });
    expect(row(l, 'UI font size').props.error).toBeUndefined();
  });
});

describe('one look per control kind (#345)', () => {
  test('a number field takes digits alone; l and ö step it while it is open', () => {
    const { l } = open();

    at(l, 'editor-general', 'Tab limit');
    key(l, '<CR>', '<D-a>', '1', 'x', '2', '<Space>');
    l.send({ kind: 'text', text: 'a3,' });
    expect(row(l, 'Tab limit').props.control).toMatchObject({ text: '123', editing: true });
    key(l, '<C-u>', 'l', 'l', 'l');
    expect(row(l, 'Tab limit').props.control).toMatchObject({ text: '3' });
    key(l, 'ö', '<Down>');
    expect(row(l, 'Tab limit').props.control).toMatchObject({ text: '1', editing: true });
    key(l, '<CR>');
    expect(row(l, 'Tab limit').props).toMatchObject({ changed: true, control: { text: '1' } });
  });

  test('a text field’s width is by what it holds: a name short, a folder wide, the rest free', () => {
    const { l } = open();
    const size = (page: string, label: string) => {
      const c = at(l, page, label).props.control;

      return c.kind === 'field' ? c.size : c.kind;
    };

    expect(size('board-team', 'Board team')).toBe('short');
    expect(size('board-team', 'Your az login folder')).toBe('path');
    expect(size('factory-policy', 'Worktree setup')).toBe('free');
    expect(size('appearance', 'UI font size')).toBe('number');
  });
});

describe('the dialog never jumps under you (#297)', () => {
  test('the settings files answer first: the page shows at once, the checks landing later move nothing', () => {
    const l = mountLayer(settingsLayer(SETTINGS_RULES));

    l.send({ kind: 'open', params: {}, size: SIZE });
    // the full list lands first: the files-only one after it is older, and dropped
    const full = settingsList(CLEAN_LAYERS);

    l.send(
      settingsListAnswer('settings:list:2', {
        ...full,
        rows: full.rows.map((x) =>
          x.id === 'limits.maxBoxesPerPerson' ? { ...x, shown: '9' } : x,
        ),
      }),
    );
    l.send(settingsListAnswer('settings:list:1', full));
    // the files-only problems: none, the page shows
    l.send(
      settingsProblemsAnswer('settings:problems:3', {
        problems: [],
        checked: { logins: false, tools: false },
      }),
    );
    expect(crumbs(l)).toBe('Appearance & Behavior › Appearance');
    click(l, 'settings:tree:boxes-cloud');
    expect(row(l, 'Max boxes per person').props.control).toMatchObject({ text: '9' });
    click(l, 'settings:tree:appearance');
    // the checks' problems seconds later: counted on Problems, the page stays
    l.send(settingsProblemsAnswer('settings:problems:4', settingsProblemsData(DEMO_LAYERS, true)));
    expect(crumbs(l)).toBe('Appearance & Behavior › Appearance');
    expect(treeRows(l).find((r) => r.label === 'Problems')?.count?.tone).toBe('warn');
  });

  test('a first open shows no page until Problems answers, then lands there', () => {
    const l = mountLayer(settingsLayer(SETTINGS_RULES));

    l.send({ kind: 'open', params: {}, size: SIZE });
    expect(crumbs(l)).toBe('Settings');
    expect(rows(l)).toMatchObject([
      { kind: 'SettingsEmpty', props: { title: 'Reading settings…' } },
    ]);
    expect(treeRows(l).some((r) => r.selected === true)).toBe(false);
    // the rows land first: still no page
    l.send(settingsListAnswer('settings:list:1', settingsList()));
    expect(crumbs(l)).toBe('Settings');
    l.send(settingsProblemsAnswer('settings:problems:2', settingsProblemsData()));
    expect(crumbs(l)).toBe('Problems · 3');
    expect(treeRows(l).find((r) => r.selected === true)?.label).toBe('Problems');
  });

  test('with no problems it shows the page once, its rows already read', () => {
    const l = mountLayer(settingsLayer(SETTINGS_RULES));

    l.send({ kind: 'open', params: {}, size: SIZE });
    l.send(
      settingsProblemsAnswer('settings:problems:2', settingsProblemsData(CLEAN_LAYERS, false)),
    );
    // Problems answered before the rows: the page, its rows said as read, never `…` then flipped
    expect(crumbs(l)).toBe('Appearance & Behavior › Appearance');
    expect(rows(l)).toMatchObject([
      { kind: 'SettingsEmpty', props: { title: 'Reading settings…' } },
    ]);
    l.send(settingsListAnswer('settings:list:1', settingsList(CLEAN_LAYERS)));
    expect(row(l, 'Chat column open by default').props.control).toEqual({
      kind: 'checkbox',
      on: false,
    });
  });

  test('a move before Problems answers keeps that page: no jump after', () => {
    const l = mountLayer(settingsLayer(SETTINGS_RULES));

    l.send({ kind: 'open', params: {}, size: SIZE });
    l.send(settingsListAnswer('settings:list:1', settingsList()));
    // the first move shows the page the cursor waited on
    key(l, 'ö');
    expect(crumbs(l)).toBe('Appearance & Behavior › Appearance');
    l.send(settingsProblemsAnswer('settings:problems:2', settingsProblemsData()));
    expect(crumbs(l)).toBe('Appearance & Behavior › Appearance');
  });

  test('Problems refused: the page shows anyway', () => {
    const l = mountLayer(settingsLayer(SETTINGS_RULES));

    l.send({ kind: 'open', params: {}, size: SIZE });
    l.send(settingsListAnswer('settings:list:1', settingsList()));
    l.send({
      kind: 'result',
      id: 'settings:problems:2',
      command: 'settings problems',
      reply: { ok: false, error: { code: 'serve-unreachable', message: 'no' } },
    });
    expect(crumbs(l)).toBe('Appearance & Behavior › Appearance');
    expect(row(l, 'Feel').props.label).toBe('Feel');
  });

  test('a problem keeps the focus when the one above goes and its text changes', () => {
    const { l } = open();

    click(l, 'settings:tree:problems');
    key(l, 'ä', 'ö', 'ö');
    const was = focused(l);

    expect(was?.kind).toBe('ProblemRow');
    const data = settingsProblemsData();
    const [, ...rest] = data.problems;
    const changed = rest.map((p, i) => (i === 1 ? { ...p, text: `${p.text} (changed)` } : p));

    l.send(settingsProblemsAnswer('settings:problems:9', { ...data, problems: changed }));
    expect(focused(l)).toMatchObject({
      kind: 'ProblemRow',
      props: { where: was?.kind === 'ProblemRow' ? was.props.where : '' },
    });
  });

  test('Logins & tools draws its rows at once as checking…, each read filling its own in place (#345)', () => {
    const { l } = open();
    const asked = runs(click(l, 'settings:tree:logins-tools'));
    const ids = () => checkRows(l).map((r) => r.id);
    const states = () => checkRows(l).map((r) => r.props.state.text);
    const scope = () => {
      const p = pageOf(l);

      return p?.kind === 'SettingsPage' ? p.props.scope : '';
    };

    // every login and tool at once, in the order the answers give them, none a warning
    expect(checkRows(l).map((r) => r.props.label)).toEqual([
      'GitHub',
      'Claude',
      'Azure DevOps',
      'node',
      'tmux',
      'Docker',
      'az',
      'gh',
      'claude',
      'git',
      'rg',
      'aws',
    ]);
    expect(new Set(states())).toEqual(new Set(['checking…']));
    // dim, none a warning nor a fix
    expect(new Set(checkRows(l).map((r) => r.props.state.tone))).toEqual(new Set(['dim']));
    expect(checkRows(l).some((r) => r.props.way !== undefined)).toBe(false);
    expect(scope()).toBe('this machine · checking…');
    const before = ids();

    // the logins land: their rows fill in, at the same places
    l.send({
      kind: 'result',
      id: asked[0]?.id ?? '',
      command: 'login status',
      reply: { ok: true, data: { ...LOGINS, who: { github: 'octocat' } } },
    });
    expect(ids()).toEqual(before);
    expect(checkRows(l)[0]?.props).toMatchObject({ label: 'GitHub', value: 'octocat' });
    expect(states()[3]).toBe('checking…');
    // ⏎ on a row still checking says so
    key(l, 'ä', 'ö', 'ö', 'ö');
    expect(checkRows(l).find((r) => r.props.focused === true)?.props.label).toBe('node');
    expect(statusOf(key(l, '<CR>'))).toEqual(['node: checking…']);
    l.send({
      kind: 'result',
      id: asked[1]?.id ?? '',
      command: 'tools check',
      reply: { ok: true, data: TOOLS },
    });
    expect(checkRows(l).map((r) => r.props.label)).toEqual([
      'GitHub',
      'Claude',
      'Azure DevOps',
      'node',
      'tmux',
    ]);
    expect(states()).not.toContain('checking…');
    noSources(l, asked);
    expect(scope()).toBe('this machine · checked when Settings opens');
  });

  test('a reopen shows the last checks while it reads them again; the focus stays on its row', () => {
    const { l } = open();

    logins(l);
    key(l, '<Esc>');
    const asked = runs(l.send({ kind: 'open', params: { page: 'logins-tools' }, size: SIZE }));
    const read = (command: string) => asked.find((c) => c.argv.join(' ') === command)?.id ?? '';

    // the last answers at once, said as being checked again
    expect(checkRows(l).map((r) => r.props.label)).toEqual([
      'GitHub',
      'Claude',
      'Azure DevOps',
      'node',
      'tmux',
    ]);
    const page = pageOf(l);

    expect(page?.kind === 'SettingsPage' ? page.props.scope : '').toBe(
      'this machine · checking again…',
    );
    key(l, 'G');
    expect(checkRows(l).find((r) => r.props.focused === true)?.props.label).toBe('tmux');
    // a tool more above it: the focus is still on tmux, not on the row now at its place
    l.send({
      kind: 'result',
      id: read('tools check'),
      command: 'tools check',
      reply: {
        ok: true,
        data: { ...TOOLS, tools: [toolCheck('docker', { found: false }, false), ...TOOLS.tools] },
      },
    });
    l.send({
      kind: 'result',
      id: read('login status'),
      command: 'login status',
      reply: { ok: true, data: LOGINS },
    });
    noSources(l, asked);
    expect(checkRows(l).map((r) => r.props.label)).toContain('Docker');
    expect(checkRows(l).find((r) => r.props.focused === true)?.props.label).toBe('tmux');
    const after = pageOf(l);

    expect(after?.kind === 'SettingsPage' ? after.props.scope : '').toBe(
      'this machine · checked when Settings opens',
    );
  });
});

describe('search counts what it shows; its keys at the top (#299)', () => {
  const scopeOf = (l: MountedLayer) => {
    const p = pageOf(l);

    return p?.kind === 'SettingsPage' ? p.props.scope : '';
  };
  const captions = (l: MountedLayer) =>
    kids(pageOf(l)).map((g) => (g.kind === 'SettingsGroup' ? g.props.caption : g.kind));

  test('leader finds the Vim row alone, the tree counts one', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    key(l, '/');
    l.send({ kind: 'text', text: 'leader' });
    expect(scopeOf(l)).toBe('1 setting on 1 page');
    expect(captions(l)).toEqual(['Vim']);
    expect(treeRows(l).find((r) => r.label === 'Vim')?.count?.text).toBe('1');
    expect(treeRows(l).find((r) => r.label === 'Font')?.dim).toBe(true);
  });

  test('a theme by its name: Islands Light finds the Theme and Scheme rows', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    key(l, '/');
    l.send({ kind: 'text', text: 'Islands Light' });
    expect(settingRows(l).map((r) => r.props.label)).toEqual(['Theme', 'Scheme']);
  });

  test('↑ or l on the first result is the search field again; k is the tree', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    key(l, '/', 't', 'a', 'b', '<CR>');
    expect(dialog(l).props.focus).toBe('page');
    key(l, '<Up>');
    expect(dialog(l).props.focus).toBe('search');
    key(l, '<CR>', 'l');
    expect(dialog(l).props.focus).toBe('search');
    key(l, '<CR>', 'k');
    expect(dialog(l).props.focus).toBe('tree');
    expect(treeRows(l).find((r) => r.selected === true)?.dim).toBeUndefined();
    // the search is kept
    expect(dialog(l).props.search.text).toBe('tab');
  });
});

describe('page polish (#300)', () => {
  test('a queued fix goes when the cursor leaves its row; the problem row says it is queued', () => {
    const { l } = open();

    click(l, 'settings:tree:problems');
    key(l, 'ä', '<CR>');
    expect(focused(l)).toMatchObject({
      kind: 'ProblemRow',
      props: { way: { label: 'queued · ⏎ runs it', tone: 'warn' } },
    });
    expect(fixOf(l)?.props.state).toBe('queued · ⏎ runs it · Esc drops it');
    key(l, 'ö');
    expect(fixOf(l)).toBeUndefined();
    key(l, 'l');
    expect(focused(l)).toMatchObject({ props: { way: { label: 'fix…' } } });
    // on Logins & tools as well, and another page never shows it
    logins(l);
    key(l, 'ä', 'ö', 'ö', '<CR>');
    expect(fixOf(l)?.props.title).toBe('fix · Azure DevOps');
    click(l, 'settings:tree:appearance');
    expect(fixOf(l)).toBeUndefined();
  });

  test('a Feel picked shows what it brings where no Layer writes it, and never the theme (#345)', () => {
    const { l } = open();

    at(l, 'appearance', 'Feel');
    const picked = key(l, '<CR>', 'ä', 'ä', '<CR>');

    expect(row(l, 'Feel').props.control).toMatchObject({ on: 'VS Code' });
    expect(row(l, 'Theme').props).toMatchObject({
      control: { kind: 'value', text: 'islands-dark' },
      source: { text: '' },
    });
    expect(looks(picked)).toEqual([]);
    // only the Feel is written
    expect(runs(picked).map((w) => w.argv)).toEqual([['settings', 'set', 'ui.feel', 'vscode']]);
    click(l, 'settings:tree:editor-general');
    expect(row(l, 'Tab limit').props.source.text).toBe('from Feel VS Code · saving…');
  });

  test('choices greyed for one reason are said once', () => {
    const { l } = open();

    at(l, 'boxes-cloud', 'Box size');
    const text = row(l, 'Box size').props.source.text;

    expect(text.match(/greyed/g)?.length).toBe(1);
    expect(text).toMatch(/^Repo · \d+ choices greyed, /);
  });

  test('a proposal starts from the value above yours and a refusal says the way out', () => {
    const layers: LayerSource[] = [
      ...DEMO_LAYERS,
      {
        place: 'local',
        file: '/work/demo-shop/.abe/settings.local.yaml',
        doc: { limits: { maxBoxDisk: 250 } },
      },
    ];
    const { l } = open({}, layers);

    at(l, 'boxes-cloud', 'Largest disk');
    key(l, '<D-CR>');
    expect(popup(l).props.value).toMatchObject({ from: '300', to: '250' });
    key(l, '<Tab>');
    l.send({ kind: 'text', text: 'smaller disks' });
    const [run] = runs(key(l, '<CR>'));

    l.send({
      kind: 'result',
      id: run?.id ?? '',
      command: 'settings propose',
      reply: {
        ok: false,
        error: { code: 'no-origin', message: '/work/demo-shop has no origin remote' },
      },
    });
    expect(popup(l).props.error).toBe(
      '/work/demo-shop has no origin remote. A proposal opens a pull request on GitHub: give this checkout its GitHub remote (git remote add origin <url>)',
    );
  });

  test('a proposal of no value sends null, as a change for you does', () => {
    const { l } = open();

    at(l, 'factory-policy', 'Worktree setup');
    key(l, '<D-CR>', '<C-u>', '<Tab>');
    l.send({ kind: 'text', text: 'no setup' });
    expect(runs(key(l, '<CR>')).map((c) => c.argv)).toEqual([
      ['settings', 'propose', 'setup', 'null', '--reason=no setup'],
    ]);
  });
});

describe('the dialog’s words and Reset colours (#325)', () => {
  test('a choice shows in words; picking one writes its value', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    expect(at(l, 'appearance', 'Feel').props.control).toEqual({
      kind: 'segmented',
      choices: ['VimStorm', 'WebStorm', 'VS Code', 'Vim'],
      on: 'VimStorm',
    });
    expect(at(l, 'editor-general', 'Changed files').props.control).toEqual({
      kind: 'segmented',
      choices: ['Colours', 'Colours and letters'],
      on: 'Colours',
    });
    expect(row(l, 'Save files').props.control).toEqual({
      kind: 'combo',
      value: 'On leaving the file',
    });
    expect(at(l, 'tools', 'Commands run').props.control).toMatchObject({
      choices: ['A cloud box', 'This machine'],
    });
    at(l, 'editor-general', 'Save files');
    key(l, '<CR>');
    expect(row(l, 'Save files').props.control).toMatchObject({
      open: {
        choices: [{ text: 'Off' }, { text: 'On leaving the file' }, { text: 'After a pause' }],
      },
    });
    // typing filters by the words
    key(l, 'p', 'a', 'u', 's', 'e');
    expect(row(l, 'Save files').props.control).toMatchObject({
      open: { choices: [{ text: 'After a pause' }] },
    });
    expect(runs(key(l, '<CR>')).map((r) => r.argv)).toEqual([
      ['settings', 'set', 'files.autoSave', 'afterDelay'],
    ]);
    expect(row(l, 'Save files').props).toMatchObject({
      control: { kind: 'combo', value: 'After a pause' },
      source: { text: 'yours · saving…' },
    });
  });

  test('⌘⏎ proposes a choice in words, writing its value; / finds a row by its words', () => {
    const { l } = open({}, CLEAN_LAYERS, false);

    at(l, 'board-team', 'Provider');
    key(l, '<D-CR>');
    expect(popup(l).props.value).toMatchObject({ kind: 'pick', to: 'GitHub Issues' });
    key(l, 'ö');
    expect(popup(l).props.value.to).toBe('Azure DevOps');
    key(l, '<Esc>');
    expect(dialog(l).children.some((c) => c.kind === 'SettingsPropose')).toBe(false);
    key(l, '/');
    l.send({ kind: 'text', text: 'devops' });
    expect(settingRows(l).map((r) => r.props.label)).toContain('Provider');
  });

  test('a source line says a value in words, never `—`', () => {
    const mine = CLEAN_LAYERS.map((x) =>
      x.place === 'machine'
        ? {
            place: x.place,
            file: x.file,
            doc: {
              chat: { openByDefault: false },
              'ui.feel': 'vscode',
              tabs: { limit: 5 },
              tree: { decorations: 'colors' },
            },
          }
        : x,
    );
    const { l } = open({}, mine, false);

    expect(at(l, 'editor-general', 'Tab limit').props.source).toEqual({
      text: 'yours · Feel VS Code has no limit',
    });
    expect(row(l, 'Changed files').props.source).toEqual({
      text: 'yours · Feel VS Code has colours and letters',
    });
    expect(row(l, 'Compact folders').props.source).toEqual({ text: 'from Feel VS Code' });
  });

  test('Reset colours heads Colours: nothing to reset says so; ⏎ puts every change back', () => {
    const l = colours();

    expect(row(l, 'Reset colours').props).toMatchObject({
      control: { kind: 'value', text: 'nothing changed' },
      help: 'back to Islands Dark’s own colours',
    });
    at(l, 'color-scheme', 'Reset colours');
    expect(statusOf(key(l, '<CR>'))).toEqual([
      'Islands Dark’s colours are its own: nothing to reset',
    ]);
    at(l, 'color-scheme', 'Filter');
    key(l, '<CR>');
    l.send({ kind: 'text', text: 'needs' });
    key(l, '<CR>', 'ö', 'ö', '<CR>', ...Array.from({ length: 7 }, () => '<BS>'));
    l.send({ kind: 'text', text: '#a979f7' });
    key(l, '<CR>');
    expect(row(l, 'Reset colours').props.control).toEqual({ kind: 'value', text: '1 changed' });
    at(l, 'color-scheme', 'Reset colours');
    expect(row(l, 'Reset colours').props.hint).toBe('⏎ reset');
    const reset = key(l, '<CR>');

    // saved at once: the theme's own colour written back over the change saved before
    expect(looks(reset)).toEqual([{ tokens: { 'abe-needs-you': '#5ec8c0' } }]);
    expect(runs(reset)[0]?.argv.slice(0, 5)).toEqual([
      'theme',
      'save',
      'islands-dark',
      '--tokens',
      '{"abe-needs-you":"#5ec8c0"}',
    ]);
    expect(row(l, 'abe-needs-you').props).toMatchObject({
      control: { kind: 'colour', hex: '#5ec8c0' },
      source: { text: '' },
    });
    expect(row(l, 'abe-needs-you').props.changed).toBeUndefined();
    expect(row(l, 'Reset colours').props.control).toEqual({
      kind: 'value',
      text: 'nothing changed',
    });
  });

  test('Reset colours on a theme of yours saves its base colours at once', () => {
    const { l, first } = open();
    const yours: Theme = {
      slug: 'islands-dark-yours',
      name: 'Islands Dark (yours)',
      base: 'islands-dark',
      source: { kind: 'yours', file: '/home/me/.config/abe/themes/islands-dark-yours.json' },
      changes: { 'abe-needs-you': '#a979f7' },
    };
    const read = l.send({
      kind: 'result',
      id: themeRead(first)[0]?.id ?? '',
      command: 'theme list',
      reply: {
        ok: true,
        data: {
          themes: themeCatalogue([yours]).map((t) => themeRow(t, yours.slug)),
          problems: [],
        },
      },
    });
    const show = runs(read);

    expect(show.map((r) => r.argv)).toEqual([['theme', 'show', yours.slug]]);
    l.send({
      kind: 'result',
      id: show[0]?.id ?? '',
      command: 'theme show',
      reply: { ok: true, data: { theme: themeRow(yours, yours.slug), groups: themeGroups(yours) } },
    });
    click(l, 'settings:tree:color-scheme');
    expect(row(l, 'Reset colours').props.control).toEqual({ kind: 'value', text: '1 changed' });
    at(l, 'color-scheme', 'Reset colours');
    const save = runs(key(l, '<CR>'));

    expect(dialog(l).props.note).toBe('Saving 1 change…');
    expect(row(l, 'Reset colours').props.control).toEqual({
      kind: 'value',
      text: 'nothing changed',
    });

    expect(save[0]?.argv.slice(0, 5)).toEqual([
      'theme',
      'save',
      yours.slug,
      '--tokens',
      '{"abe-needs-you":"#5ec8c0"}',
    ]);
  });

  test('a list answer that drops results above the focus keeps it on its row, never its index', () => {
    const { l } = open({}, CLEAN_LAYERS, false);
    const data = settingsList(CLEAN_LAYERS);
    const ids = ['tree.autoReveal', 'tree.singleClick', 'tree.compactFolders', 'tabs.dirtyDot'];
    const marked = (on: readonly string[]): SettingsListData => ({
      ...data,
      rows: data.rows.map((r) => (on.includes(r.id) ? { ...r, shown: 'zebra' } : r)),
    });

    l.send(settingsListAnswer('settings:list:7', marked(ids)));
    key(l, '/');
    l.send({ kind: 'text', text: 'zebra' });
    key(l, '<CR>', 'ö', 'ö', 'ö');
    expect(focused(l)).toMatchObject({ props: { label: 'Mark unsaved tabs with ●' } });
    // three of four go and one comes below: the focus was the fourth result, now the first
    l.send(settingsListAnswer('settings:list:8', marked(['tabs.dirtyDot', 'editor.minimap'])));
    expect(settingRows(l).map((r) => r.props.label)).toEqual([
      'Mark unsaved tabs with ●',
      'Show the minimap',
    ]);
    expect(focused(l)).toMatchObject({ props: { label: 'Mark unsaved tabs with ●' } });
  });
});

describe('the Theme row’s cells say it all (#325)', () => {
  test('no help right of the cells, no source line under the last one; a pick being saved says so', () => {
    const { l, first } = open();

    l.send(themeListAnswer(themeRead(first)[0]?.id ?? ''));
    click(l, 'settings:tree:appearance');
    expect(row(l, 'Theme').props.help).toBeUndefined();
    expect(row(l, 'Theme').props.source).toEqual({ text: '' });
    click(l, row(l, 'Theme').id ?? '');
    key(l, '<CR>', 'ä', '<CR>');
    expect(row(l, 'Theme').props.source).toEqual({ text: 'yours · saving…', tone: 'link' });
  });
});

describe('typed inputs: each setting by its kind, never raw JSON', () => {
  test('a list opens in place: + Add, an item typed, removed, moved, each saved at once', () => {
    const { l } = open();

    at(l, 'factory-policy', 'Test files');
    key(l, '<CR>');
    const opened = row(l, 'Test files').props.control;

    expect(opened).toMatchObject({ kind: 'list', open: { cursor: 0 } });
    key(l, 'a');
    l.send({ kind: 'text', text: 'e2e/' });
    expect(row(l, 'Test files').props.control).toMatchObject({
      open: { field: { at: null, text: 'e2e/' } },
    });
    const [write] = runs(key(l, '<CR>'));
    const added = row(l, 'Test files').props;

    expect(write?.argv.slice(0, 3)).toEqual(['settings', 'set', 'testFiles']);
    expect(added.changed).toBe(true);
    expect(added.control.kind === 'list' ? added.control.items.map((i) => i.text) : []).toEqual([
      '*.test.*',
      '*.spec.*',
      'test/',
      'tests/',
      'e2e/',
    ]);
    // the cursor on the new one, moved up, then the first removed
    key(l, 'l', 'L', 'gg');
    key(l, 'l', 'l', 'l', 'l', 'l', 'x');
    const p = row(l, 'Test files').props.control;

    expect(p.kind === 'list' ? p.items.map((i) => i.text) : []).toEqual([
      '*.spec.*',
      'test/',
      'e2e/',
      'tests/',
    ]);
    key(l, '<Esc>');
    expect(row(l, 'Test files').props.control).toEqual({
      kind: 'list',
      items: ['*.spec.*', 'test/', 'e2e/', 'tests/'].map((text) => ({ text })),
    });
  });

  test("a list's item refused says why under the row and saves nothing", () => {
    const { l } = open();

    at(l, 'factory-policy', 'Fixed ports');
    key(l, '<CR>', 'a');
    l.send({ kind: 'text', text: '99999' });
    expect(runs(key(l, '<CR>'))).toEqual([]);
    const p = row(l, 'Fixed ports').props;

    expect(p.changed).toBeUndefined();
    expect(p.error).toContain('65535');
    expect(p.control).toMatchObject({ open: { field: { at: null, text: '99999' } } });
  });

  test('a field says why as it is typed; ⏎ on it never saves', () => {
    const { l } = open();

    at(l, 'boxes-cloud', 'Largest disk');
    key(l, '<CR>', '<D-a>', '9');
    expect(row(l, 'Largest disk').props.error).toBe('Needs a whole number from 40 to 4096');
    // said as typed: no change refused in the footer
    expect(dialog(l).props.note).not.toContain('refused');
    expect(runs(key(l, '<CR>'))).toEqual([]);
    expect(row(l, 'Largest disk').props.changed).toBeUndefined();
    key(l, '0');
    expect(row(l, 'Largest disk').props.error).toBeUndefined();
  });

  test('an account is a dropdown of what serve knows, none first; a name typed is taken, read as set reads it', () => {
    const { l } = open();

    at(l, 'boxes-cloud', 'AWS profile');
    key(l, '<CR>');
    expect(row(l, 'AWS profile').props.control).toMatchObject({
      kind: 'combo',
      value: 'none · the default profile',
      open: {
        choices: [
          { text: 'none · the default profile' },
          { text: 'demo-dev' },
          { text: 'demo-tooling' },
        ],
        cursor: 0,
      },
    });
    expect(runs(key(l, '<Down>', '<CR>')).map((w) => w.argv)).toEqual([
      ['settings', 'set', 'box.profile', 'demo-dev'],
    ]);
    // a region it has no name for: typed, offered as itself, refused under the row, nothing saved
    at(l, 'boxes-cloud', 'AWS region');
    key(l, '<CR>', 'e', 'u');
    const open_ = row(l, 'AWS region').props.control;

    expect(open_.kind === 'combo' ? open_.open?.choices.at(-1)?.text : '').toBe('Use “eu”');
    expect(runs(key(l, '<End>', '<CR>'))).toEqual([]);
    expect(row(l, 'AWS region').props).toMatchObject({
      control: { kind: 'combo', value: "none · the profile's own" },
      error: 'an AWS region, like eu-west-1',
    });
    expect(row(l, 'AWS region').props.control).not.toHaveProperty('open');
    expect(row(l, 'AWS region').props.changed).toBeUndefined();
    // Done when: merged, then the repo's environments
    at(l, 'factory-policy', 'Done when');
    key(l, '<CR>');
    const done = row(l, 'Done when').props.control;

    expect(done.kind === 'combo' ? done.open?.choices.map((c) => c.text) : []).toEqual([
      'merged',
      'test',
    ]);
  });

  test('scope and default per row; ⌫ takes yours out at once with settings unset', () => {
    const { l } = open();
    const r = at(l, 'appearance', 'Chat column open by default').props;

    expect([r.scope, r.reset?.label, r.reset?.id.startsWith('settings:reset:'), r.hint]).toEqual([
      'yours',
      'Reset',
      true,
      'Space or ⏎ toggle · ⌫ reset · yours alone: not for the repo',
    ]);
    // the built-in value in force says no default: it is the default
    expect(row(l, 'UI font size').props.default).toBeUndefined();
    click(l, 'settings:tree:boxes-cloud');
    expect(row(l, 'Largest disk').props).toMatchObject({ scope: 'local', default: '200' });
    click(l, 'settings:tree:appearance');
    click(l, row(l, 'Chat column open by default').id ?? '');
    expect(runs(key(l, '<BS>')).map((c) => c.argv)).toEqual([
      ['settings', 'unset', 'chat.openByDefault'],
    ]);
    expect(row(l, 'Chat column open by default').props).toMatchObject({
      control: { kind: 'checkbox', on: true },
      source: { text: 'reset to default · saving…' },
      changed: true,
    });
    expect(row(l, 'Chat column open by default').props.reset).toBeUndefined();
    expect(row(l, 'Chat column open by default').props.hint).not.toContain('⌫ reset');
  });

  test("a folder's Choose… opens its field for the panel's pick, which ⏎ saves", () => {
    const { l } = open();

    click(l, 'settings:tree:board-team');
    const r = row(l, 'Your az login folder');

    expect(r.props.control).toMatchObject({ kind: 'path', browse: { label: 'Choose…' } });
    const browse = r.props.control.kind === 'path' ? r.props.control.browse.id : '';

    click(l, browse);
    l.send({ kind: 'text', text: '/home/me/.azure-demo' });
    key(l, '<CR>');
    expect(row(l, 'Your az login folder').props).toMatchObject({
      control: { kind: 'path', text: '/home/me/.azure-demo' },
      changed: true,
    });
  });

  test('records: View tweaks as rows of fields; a cell typed or picked saves the whole setting, a lacking one says why', () => {
    const { l } = open({}, RECORDS_LAYERS);

    at(l, 'appearance', 'View tweaks');
    expect(row(l, 'View tweaks').props.control).toMatchObject({
      kind: 'records',
      rows: [['factory', 'col:Closed', 'hide', '']],
    });
    // a tweak added: its Screen's list open, filtered as typed
    key(l, '<CR>', 'a', 'c', 'h');
    const pick = row(l, 'View tweaks').props.control;

    expect(pick.kind === 'records' ? pick.open?.pick?.choices.map((c) => c.text) : []).toEqual([
      'chat',
    ]);
    expect(runs(key(l, '<CR>'))).toEqual([]);
    expect(row(l, 'View tweaks').props.error).toBe('Row 2: Part is empty');
    key(l, 'ä', '<CR>');
    l.send({ kind: 'text', text: 'chat-header' });
    key(l, '<CR>', 'ä', '<CR>');
    const [w] = runs(key(l, '<CR>'));

    expect(w?.argv).toEqual([
      'settings',
      'set',
      'views',
      JSON.stringify([
        { screen: 'factory', node: 'col:Closed', hide: true },
        { screen: 'chat', node: 'chat-header', hide: true },
      ]),
    ]);
    expect(row(l, 'View tweaks').props.error).toBeUndefined();
    // the first removed: saved at once, the editor kept open
    const [gone] = runs(key(l, 'gg', 'l', 'x'));

    expect(gone?.argv[3]).toBe(
      JSON.stringify([{ screen: 'chat', node: 'chat-header', hide: true }]),
    );
    expect(row(l, 'View tweaks').props.control).toMatchObject({ open: { row: 0 } });
    key(l, '<Esc>');
    expect(row(l, 'View tweaks').props.control).not.toHaveProperty('open');
  });

  test('records: environments by name, account and the rest; a click edits a cell, ✕ removes a record', () => {
    const { l } = open({}, RECORDS_LAYERS);

    at(l, 'reach', 'Environments');
    expect(row(l, 'Environments').props.control).toMatchObject({
      kind: 'records',
      rows: [
        ['test', '111111111111', 'eu-north-1', '', 'demo/test-read', ''],
        ['prod', '222222222222', '', 'policies/prod-write.json', '', ''],
      ],
    });
    key(l, '<CR>');
    click(l, 'settings:cell:1:2');
    click(l, 'settings:cell:1:2');
    l.send({ kind: 'text', text: 'eu-north-1' });
    const [w] = runs(key(l, '<CR>'));

    expect(w?.argv[3]).toContain('"prod":{"account":"222222222222","region":"eu-north-1"');
    const [gone] = runs(click(l, 'settings:record-remove:0'));

    expect(gone?.argv[3]).toBe(
      '{"prod":{"account":"222222222222","region":"eu-north-1","writePolicy":"policies/prod-write.json"}}',
    );
  });
});

describe('the mouse alone: one click on a control acts, its row focused', () => {
  /** A step of a row: a part of the row's control (`:press`, `:choice:1`), another id, a key or text. */
  type Step = string | { key: string } | { text: string };
  type MouseRow = [
    string,
    readonly LayerSource[],
    string,
    string,
    Step[],
    (l: MountedLayer, label: string, cs: Command[]) => void,
  ];
  const argv = (cs: Command[]) => runs(cs).map((w) => w.argv);
  const control = (l: MountedLayer, label: string) => row(l, label).props.control;
  const focusedOn = (l: MountedLayer, label: string) => {
    expect(focused(l)).toMatchObject({ props: { label } });
  };

  test.each<MouseRow>([
    [
      'checkbox: a click toggles it and saves',
      DEMO_LAYERS,
      'appearance',
      'Chat column open by default',
      [':press'],
      (l, label, cs) => {
        expect(argv(cs).map((a) => a[3])).toEqual(['true']);
        expect(control(l, label)).toMatchObject({ kind: 'checkbox', on: true });
        focusedOn(l, label);
      },
    ],
    [
      'combo: a click opens it',
      DEMO_LAYERS,
      'agents',
      'Reader',
      [':press'],
      (l, label) => {
        expect(control(l, label)).toMatchObject({ kind: 'combo', open: { cursor: 1 } });
        focusedOn(l, label);
      },
    ],
    [
      'combo: a click on a choice picks it',
      DEMO_LAYERS,
      'agents',
      'Reader',
      [':press', 'settings:choice:0'],
      (l, label, cs) => {
        expect(argv(cs)).toEqual([['settings', 'set', 'models.reader', 'opus']]);
        expect(control(l, label)).toEqual({ kind: 'combo', value: 'opus' });
      },
    ],
    [
      'combo: a click outside or on it again closes it, nothing saved',
      DEMO_LAYERS,
      'agents',
      'Reader',
      [':press', 'settings:page', ':press', ':press'],
      (l, label, cs) => {
        expect(argv(cs)).toEqual([]);
        expect(control(l, label)).not.toHaveProperty('open');
      },
    ],
    [
      'segmented: a click on a segment picks that segment',
      CLEAN_LAYERS,
      'agents',
      "Your MCP servers, never a repo's",
      [':choice:1'],
      (l, label, cs) => {
        expect(argv(cs)).toHaveLength(1);
        expect(control(l, label)).toMatchObject({ kind: 'segmented', on: "Abe's only" });
        expect(control(l, label)).not.toHaveProperty('editing');
        focusedOn(l, label);
      },
    ],
    [
      'number: a click starts editing; a click in it keeps the caret',
      DEMO_LAYERS,
      'boxes-cloud',
      'Largest disk',
      [':press', { text: '0' }, ':press'],
      (l, label, cs) => {
        expect(argv(cs)).toEqual([]);
        expect(control(l, label)).toMatchObject({ kind: 'field', text: '3000', editing: true });
        focusedOn(l, label);
      },
    ],
    [
      'number: a click elsewhere commits as ⏎ does',
      DEMO_LAYERS,
      'boxes-cloud',
      'Largest disk',
      [
        ':press',
        { key: '<BS>' },
        { key: '<BS>' },
        { key: '<BS>' },
        { text: '200' },
        'settings:page',
      ],
      (l, label, cs) => {
        expect(argv(cs)).toEqual([['settings', 'set', 'limits.maxBoxDisk', '200']]);
        expect(control(l, label)).not.toHaveProperty('editing');
      },
    ],
    [
      'number: a click on another row commits, then focuses it',
      DEMO_LAYERS,
      'boxes-cloud',
      'Largest disk',
      [
        ':press',
        { key: '<BS>' },
        { key: '<BS>' },
        { key: '<BS>' },
        { text: '200' },
        'settings:line:0',
      ],
      (l, _, cs) => {
        expect(argv(cs)).toEqual([['settings', 'set', 'limits.maxBoxDisk', '200']]);
        expect(focused(l)?.id).toBe('settings:line:0');
      },
    ],
    [
      'number: Esc cancels what was typed',
      DEMO_LAYERS,
      'boxes-cloud',
      'Largest disk',
      [':press', { text: '0' }, { key: '<Esc>' }, 'settings:page'],
      (l, label, cs) => {
        expect(argv(cs)).toEqual([]);
        expect(control(l, label)).toMatchObject({ kind: 'field', text: '300' });
      },
    ],
    [
      'folder: a click starts editing',
      DEMO_LAYERS,
      'board-team',
      'Your az login folder',
      [':press'],
      (l, label) => {
        expect(control(l, label)).toMatchObject({ kind: 'path', editing: true });
      },
    ],
    [
      'list: a click opens it, a click on an item types in it',
      DEMO_LAYERS,
      'agents',
      'Allowed models',
      [':press', 'settings:item:1'],
      (l, label) => {
        expect(control(l, label)).toMatchObject({
          kind: 'list',
          open: { cursor: 1, field: { at: 1, text: 'sonnet' } },
        });
      },
    ],
    [
      'records: a click on a cell opens them on it, typed in',
      RECORDS_LAYERS,
      'reach',
      'Environments',
      [':cell:1:2'],
      (l, label) => {
        expect(control(l, label)).toMatchObject({
          kind: 'records',
          open: { row: 1, col: 2, field: { text: '' } },
        });
        focusedOn(l, label);
      },
    ],
    [
      'records: a new record’s cell typed, a click on the next cell types there (the refusal says why)',
      RECORDS_LAYERS,
      'reach',
      'Environments',
      [':press', 'settings:record-add', { text: 'qa' }, 'settings:cell:2:1'],
      (l, label, cs) => {
        expect(argv(cs)).toEqual([]);
        expect(control(l, label)).toMatchObject({
          open: { row: 2, col: 1, field: { text: '' } },
        });
        expect(row(l, label).props.error).toContain('AWS account');
      },
    ],
    [
      'a click on a row’s label only focuses it',
      DEMO_LAYERS,
      'agents',
      'Reader',
      [''],
      (l, label, cs) => {
        expect(argv(cs)).toEqual([]);
        expect(control(l, label)).not.toHaveProperty('open');
        focusedOn(l, label);
      },
    ],
  ])('%s', (_, layers, page, label, steps, want) => {
    const { l } = open({}, layers, false);

    click(l, `settings:tree:${page}`);
    const id = row(l, label).id ?? '';
    const cs = steps.flatMap((s) => {
      if (typeof s !== 'string')
        return l.send('key' in s ? { kind: 'key', key: s.key } : { kind: 'text', text: s.text });
      return click(l, s.startsWith('settings:') ? s : `${id}${s}`);
    });

    want(l, label, cs);
  });

  test('a problem’s fix… button acts on one click', () => {
    const { l } = open();

    click(l, 'settings:tree:problems');
    click(l, 'settings:line:0:press');
    expect(fixOf(l)?.props).toMatchObject({ title: 'fix · AWS SSO' });
  });
});
