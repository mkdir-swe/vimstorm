/**
 * The Editor's `:` (#346): what the app says of it before `:` becomes Command mode's Subject (the
 * file at the caret, its context menu's items as rows run in Lua), `Run in Neovim` from its Ex
 * command names, and its view's row (Board).
 */
import { describe, expect, test } from 'bun:test';
import { helpAnswer } from '@abe/testing';
import { commandMode } from './command';
import { EDITOR_MENU, editorHere } from './editor-here';
import { type Input, mountLayer } from '../runtime/runtime';
import { WORDS } from '../runtime/screens';

const key = (k: string): Input => ({ kind: 'key', key: k });

const EDITOR = {
  ex: ['write', 'wq', 'quit', 'substitute', 'new'],
  caret: { file: 'api/src/cart.ts', line: 42 },
  items: [
    { text: 'Go to Declaration', key: '⌘B' },
    { text: 'Find Usages', key: '⌥F7' },
    { text: 'Rename…', key: '⇧F6' },
    { text: 'Rollback Lines', key: '⌘⌥Z', enabled: false },
    { text: 'Search Everywhere', key: '⇧⇧' },
  ],
};

describe('the Editor’s here (#346)', () => {
  test('the caret’s file and line: caption, Ask’s label and flags, its items as rows', () => {
    const h = editorHere(EDITOR, { serving: true, project: 'demo-shop' });

    expect(h.ex).toEqual(EDITOR.ex);
    expect(h.here.keys).toBe('editor');
    expect(h.here.subject).toMatchObject({
      caption: 'api/src/cart.ts:42',
      label: 'cart.ts:42',
      ask: ['--file', 'api/src/cart.ts', '--line', '42'],
    });
    expect(h.here.subject?.menu?.id).toBe(EDITOR_MENU);
    expect(h.here.subject?.menu?.rows.map((r) => [r.text, r.key, r.does])).toEqual([
      ['Go to Declaration', '⌘B', { kind: 'shell', effect: { kind: 'editor-item', index: 0 } }],
      ['Find Usages', '⌥F7', { kind: 'shell', effect: { kind: 'editor-item', index: 1 } }],
      ['Rename…', '⇧F6', { kind: 'shell', effect: { kind: 'editor-item', index: 2 } }],
      ['Rollback Lines', '⌘⌥Z', { kind: 'shell', effect: { kind: 'editor-item', index: 3 } }],
    ]);
    // a grey item stays grey (⌘⏎'s whole menu); Search Everywhere is Anywhere's already
    expect(h.here.subject?.menu?.rows[3]?.reason).toBe('not here');
    // a board is in force only where the Board says so
    expect(h.here.board).toBe(false);
    expect(editorHere(EDITOR, { serving: true, board: true }).here.board).toBe(true);
  });

  test('the view’s row: Board; the stripe’s items are Go to’s, at the Project place (#11)', () => {
    const h = editorHere(EDITOR, { serving: true });

    expect(h.here.view?.menu.rows.map((r) => [r.text, r.key, r.does])).toEqual([
      ['Board', '⌘⌥A', { kind: 'shell', effect: { kind: 'view', view: 'factory' } }],
    ]);
    expect(h.place).toBe('project');
  });

  test('a selection: its lines in the caption and `--selection`', () => {
    const h = editorHere(
      { ...EDITOR, caret: { file: 'cart.ts', line: 18, selection: { from: 12, to: 18 } } },
      { serving: true },
    );

    expect(h.here.subject).toMatchObject({
      caption: 'cart.ts:12–18',
      ask: ['--file', 'cart.ts', '--line', '18', '--selection', '12-18'],
    });
  });

  test('no file: no Subject, Ask about the project', () => {
    const h = editorHere({ ex: [], items: [] }, { serving: true, project: 'demo-shop' });

    expect(h.here.subject).toBeUndefined();
    expect(h.project).toBe('demo-shop');
  });
});

describe('`:` in the Editor through Command mode (#346)', () => {
  const opened = () => {
    const layer = mountLayer(commandMode(WORDS));

    layer.send(editorHere(EDITOR, { serving: true, project: 'demo-shop' }));
    layer.send(key(':'));
    layer.send(helpAnswer());

    return layer;
  };

  test('nothing typed: the caret’s items first under its caption, then Board', () => {
    const t = opened().tree;
    const rows = t?.kind === 'PickLayer' ? t.props.rows : [];

    expect(rows.slice(0, 3).map((r) => r.text)).toEqual([
      'Go to Declaration',
      'Find Usages',
      'Rename…',
    ]);
    expect(rows[0]?.section).toBe('api/src/cart.ts:42');
    expect(rows.find((r) => r.text === 'Board')?.section).toBe('Editor');
  });

  test('`:w⏎`: Run in Neovim, the `ex` shell effect', () => {
    const l = opened();

    l.send(key('w'));
    expect(l.send(key('<CR>'))).toEqual([{ kind: 'shell', effect: { kind: 'ex', text: 'w' } }]);
  });

  test('an item chosen: the `editor-item` shell effect, Lua runs it', () => {
    const l = opened();

    l.send(key('<Down>'));
    expect(l.send(key('<CR>'))).toEqual([
      { kind: 'shell', effect: { kind: 'editor-item', index: 1 } },
    ]);
  });

  test('a sentence goes to the Abe chat about the caret', () => {
    const l = opened();

    for (const c of 'why is this slow') l.send(key(c === ' ' ? '<Space>' : c));
    const out = l.send(key('<CR>'));

    expect(out).toEqual([
      {
        kind: 'run',
        id: 'ask-run:1',
        argv: ['chat', 'why', 'is', 'this', 'slow', '(about api/src/cart.ts:42)'],
      },
    ]);
  });
});
