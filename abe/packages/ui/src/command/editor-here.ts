/**
 * Where the Editor's keys are, for `:` and `?` (#346): the app sends it just before the Editor's
 * `:` (`editor-here`). The Subject is the file at the caret (the selection if any): `Ask about
 * cart.ts:42`, said to the Abe chat as `(about api/src/cart.ts:42)`, its rows the caret's context menu items (what ⌘⏎
 * and a right-click show there, `config/menu.lua`), each run in Lua as the `editor-item` shell
 * effect; the view's row is the Board (the stripe's items are `:`'s Go to once typed, #11); the Ex
 * command names give `Run in Neovim`.
 */
import type { Caret, EditorHereData } from '../runtime/protocol';
import type { HereInput, Menu } from '../runtime/runtime';

/** The Editor's caret menu as `:` lists it: chosen rows go to Lua, never to a screen. */
export const EDITOR_MENU = 'editor:context';

/** What the app said of the Editor before `:`. */
export type EditorHere = EditorHereData;

/** The caret menu's items `:` already has elsewhere (Anywhere's). */
const ANYWHERE = new Set(['Search Everywhere']);

const basename = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

/** Why a grey item can't run, as the menu draws it grey with no words. */
const GREY = 'not here';

/** `cart.ts:42`, `cart.ts:12–18` with a selection. */
const at = (c: Caret, name: string): string =>
  c.selection === undefined || c.selection.from === c.selection.to
    ? `${name}:${c.line}`
    : `${name}:${c.selection.from}–${c.selection.to}`;

/** The caret's context menu: each item run in Lua by its index. */
const caretMenu = (title: string, items: EditorHere['items']): Menu => ({
  kind: 'menu',
  id: EDITOR_MENU,
  title,
  // each by its index in what Lua sent: the one it runs
  rows: items.flatMap((item, index) =>
    ANYWHERE.has(item.text)
      ? []
      : [
          {
            id: `item:${index}`,
            text: item.text,
            ...(item.key === undefined ? {} : { key: item.key }),
            ...(item.enabled === false ? { reason: GREY } : {}),
            does: { kind: 'shell' as const, effect: { kind: 'editor-item' as const, index } },
          },
        ],
  ),
});

/** The Editor's `here` for Command mode (`serving`, `project` as the bridge knows them). */
export const editorHere = (
  e: EditorHere,
  o: {
    serving: boolean;
    project?: string | undefined;
    checkout?: HereInput['checkout'];
    stripe?: HereInput['stripe'];
    board?: boolean | undefined;
  },
): HereInput => {
  const c = e.caret;
  const subject =
    c === undefined
      ? undefined
      : {
          caption: at(c, c.file),
          label: at(c, basename(c.file)),
          ask: [
            '--file',
            c.file,
            '--line',
            String(c.line),
            ...(c.selection === undefined || c.selection.from === c.selection.to
              ? []
              : ['--selection', `${c.selection.from}-${c.selection.to}`]),
          ],
          ...(e.items.length === 0 ? {} : { menu: caretMenu(at(c, c.file), e.items) }),
        };

  return {
    kind: 'here',
    here: {
      keys: 'editor',
      // `New card “…”` only where the Board has a board (#346)
      board: o.board === true,
      view: {
        title: 'Editor',
        menu: {
          kind: 'menu',
          id: 'editor:view',
          title: 'Editor',
          rows: [
            {
              id: 'board',
              text: 'Board',
              dim: 'the Abe view',
              key: '⌘⌥A',
              does: { kind: 'shell', effect: { kind: 'view', view: 'factory' } },
            },
          ],
        },
      },
      ...(subject === undefined ? {} : { subject }),
    },
    serving: o.serving,
    ...(o.project === undefined ? {} : { project: o.project }),
    ...(o.checkout === undefined ? {} : { checkout: o.checkout }),
    // the Editor's `:` is the code's: the Project place
    place: 'project',
    ...(o.stripe === undefined ? {} : { stripe: o.stripe }),
    ex: e.ex,
  };
};
