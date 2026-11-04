/**
 * The key help (board Keys): `?` with no layer up opens this view's keys as Command mode's menu,
 * `??` every key; the jumps and their ⌃⌥ forms are on it (#106 AC 7); typing filters, Esc closes.
 */
import { describe, expect, test } from 'bun:test';
import { commandMode } from './command';
import { keyHelp } from './keys';
import { type CardDialog, type PickLayer } from '../runtime/layers';
import { type Dialog, type Input, mountLayer } from '../runtime/runtime';
import { WORDS } from '../runtime/screens';

/** A dialog as a screen hands it to Command mode: a story's (card 4), or Make card's draft (0). */
const dialogOf = (card: number): Dialog => {
  const dialog: CardDialog = {
    kind: 'CardDialog',
    id: `dialog:${card}`,
    props: {
      kicker: 'Story',
      ...(card > 0 ? { heading: 'Story · demo-shop' } : {}),
      card,
      state: 'Active',
      title: 'Cart total includes shipping',
      meta: [],
      sections: [{ title: 'Description', markdown: 'The cart adds shipping.' }],
      scroll: 0,
      buttons: [{ id: 'dialog:primary', label: 'Launch agent', primary: true }],
    },
  };

  return { kind: 'dialog', id: `dialog:${card}`, dialog, lines: 30 };
};

const drive = () => {
  const layer = mountLayer(commandMode(WORDS));
  const d = {
    send(input: Input) {
      layer.send(input);

      return d;
    },
    keys(...keys: string[]) {
      for (const key of keys) layer.send({ kind: 'key', key } satisfies Input);

      return d;
    },
    get pick(): PickLayer['props'] | undefined {
      return layer.tree?.kind === 'PickLayer' ? layer.tree.props : undefined;
    },
    get kind(): string | undefined {
      return layer.tree?.kind;
    },
    get scroll(): number | undefined {
      return layer.tree?.kind === 'CardDialog' ? layer.tree.props.scroll : undefined;
    },
  };

  return d;
};

/** Every row of a key help, as `key text` lines of one section. */
const section = (every: boolean, name: string): string[] =>
  keyHelp(every ? 'every' : 'view')
    .rows.filter((r) => r.dim === name)
    .map((r) => `${r.key ?? ''} ${r.text}`);

describe('? and ??', () => {
  test('? lists this view’s keys: the Board’s first, the window’s, the jumps, the layers’', () => {
    const d = drive().keys('?');

    expect(d.pick?.title).toBe('Abe view keys · ? every key');
    expect([...new Set(keyHelp().rows.map((r) => r.dim))]).toEqual([
      'Board',
      'Views & panes',
      'Jumps',
      'Layers',
    ]);
    // the window's keys too: ⌘⌥A (#281)
    expect(keyHelp().rows.map((r) => r.key)).toContain('⌘⌥A');
    expect(d.pick?.rows[0]).toMatchObject({
      text: 'The card’s page, as a popup over the Board',
      note: '⏎',
    });
  });

  test('the Board’s rows are every key it takes (#250)', () => {
    const board = keyHelp()
      .rows.filter((r) => r.dim === 'Board')
      .map((r) => r.key);

    expect(board).toEqual([
      '⏎',
      '⌘⏎ · right-click',
      'k ä',
      'l ö',
      'L Ö',
      'gg G · Home End',
      '3ö · 5G',
      '⇟ ⇞ · ⌃F ⌃B',
      '⌃D ⌃U',
      'Tab ⇧Tab',
      'l ö · ⏎',
      '/',
      'r',
      'Esc',
      ':',
      'wheel',
    ]);
  });

  test('?? has a section for the dialogs, Linked, Command mode and Settings (#281)', () => {
    const sections = new Set(keyHelp('every').rows.map((r) => r.dim));

    for (const s of ['Dialogs', 'Linked', 'Command mode', 'Settings'])
      expect(sections).toContain(s);
    expect(section(true, 'Story dialog')).toContain(
      'Tab ⇧Tab Past its buttons into its Sheets · back out',
    );
    expect(section(true, 'Settings')).toContain('⌘Z Undo the last save');
  });

  test('? in the story dialog lists its keys over it; ⏎ or Esc back to the dialog (#281)', () => {
    const d = drive().send(dialogOf(4)).keys('ö', 'ö');

    expect(d.scroll).toBe(2);
    d.keys('?');
    expect(d.pick?.title).toBe('Story dialog keys · ? every key');
    // (the pick shows a window of its rows)
    expect(new Set(keyHelp('story').rows.map((r) => r.dim))).toEqual(
      new Set(['Dialogs', 'Story dialog', 'Jumps', 'Layers']),
    );
    expect(d.pick?.rows.slice(0, 9).map((r) => r.note)).toEqual([
      '⏎',
      '← → · k ä · Tab ⇧Tab',
      '⌘⏎',
      'l ö',
      'gg G · Home End',
      ':',
      'Esc',
      'Tab ⇧Tab',
      'l ö · ⏎',
    ]);
    expect(keyHelp('story').rows.map((r) => r.key)).toContain('⌃L');
    d.keys('<Esc>');
    expect(d.kind).toBe('CardDialog');
    expect(d.scroll).toBe(2);
    // ?? every key, ⏎ on a row back to the dialog too
    d.keys('?', '?');
    expect(d.pick?.title).toBe('Every key');
    d.keys('<CR>');
    expect(d.kind).toBe('CardDialog');
    // another dialog (Make card's draft): its own title, no Sheets or jumps
    const other = drive().send(dialogOf(0)).keys('?').pick;

    expect(other?.title).toBe('Dialog keys · ? every key');
    expect(new Set(other?.rows.map((r) => r.dim))).toEqual(new Set(['Dialogs', 'Layers']));
    // a `g` before `?` waits no more: `g ? Esc g` is no `gg`
    const g = drive().send(dialogOf(4)).keys('ö', 'ö', 'g', '?', '<Esc>', 'g');

    expect(g.scroll).toBe(2);
  });

  test(': in the story dialog opens Command mode over it; Esc back to the dialog (#281)', () => {
    const d = drive().send(dialogOf(4)).keys(':');

    expect(d.pick?.title).toBe('Command mode');
    d.keys('<Esc>');
    expect(d.kind).toBe('CardDialog');
  });

  test('?? lists every key, the jumps with their ⌃⌥ forms and the two exceptions', () => {
    const d = drive().keys('?', '?');

    expect(d.pick?.title).toBe('Every key');
    expect(d.pick?.filter).toBe('');
    expect(d.pick?.rows[0]).toMatchObject({ note: '⌘1' });
    expect(d.pick?.rows[0]?.text).toContain('Project tree');
    // a third ? types nothing
    expect(d.keys('?').pick?.filter).toBe('');
    // a section by its name (the menu shows a window of its rows)
    const jumps = d.keys('J', 'u', 'm').pick?.rows.map((r) => [r.note, r.text]);

    // (the exceptions first: `jump` is in their words too)
    expect(jumps).toEqual([
      ['⌃L', 'In an nvim split: add a caret above; ⌃⌥ jumps there'],
      ['⌃L', 'In a terminal: the shell’s; ⌃⌥ jumps there'],
      ['⌃L', 'Linked: everything on the story'],
      ['⌃⌥L', 'The same, from anywhere'],
    ]);
    // the g jumps are gone; gg and G stay as moves
    expect(
      new Set(
        keyHelp('every')
          .rows.filter((r) => r.key?.startsWith('g') === true)
          .map((r) => r.key),
      ),
    ).toEqual(new Set(['gg G · Home End', 'gg G · 5G Home End']));
  });

  test('typing filters at once; ⏎ and Esc close it', () => {
    const d = drive().keys('?', 'n', 'v', 'i', 'm');

    expect(d.pick?.rows.map((r) => r.text)).toEqual([
      'In an nvim split: add a caret above; ⌃⌥ jumps there',
    ]);
    expect(d.keys('<CR>').pick).toBeUndefined();
    expect(drive().keys('?', '<Esc>').pick).toBeUndefined();
  });
});
