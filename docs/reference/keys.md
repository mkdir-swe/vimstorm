# Keys and Feels

The Feels (VimStorm, VS Code keys, Vim mode off, stock Vim) and VimStorm's own Vim keys.

## Feel vscode keys

With the Feel `vscode` (`abe settings set ui.feel vscode`), VS Code's macOS chords do VS Code's things, and Vim mode is off (see Vim mode off below; `abe settings set editor.vim true` turns Vim mode on with these chords, stock Vim keys as under the Feel `vim`). Under any other Feel the WebStorm keys above stay exactly as they are. The right-click menus and the macOS menu bar show these chords; a menu bar item whose VS Code key is an F-key, an Alt key, a two-key chord or one VimStorm doesn't have (Declaration or Usages, Rename…, Commit…) shows none and still does its action.

| Key | Action |
|---|---|
| Cmd+P | Go to File |
| Cmd+Shift+P | Command palette (Command mode, as `:`) |
| Cmd+B | Show / hide the Project tree |
| Cmd+J | Show / hide Code's bottom panel (as under every Feel) |
| Cmd+Shift+M | The bottom panel's Problems tab (the workspace's errors and warnings by file; Enter or a click opens one) |
| Cmd+\ (Swedish Cmd+Alt+Shift+7) | Split right |
| Alt+Up / Alt+Down | Move the line or the selected lines |
| Alt+Shift+Up / Alt+Shift+Down | Copy the line or the selected lines up / down |
| Cmd+Shift+K | Delete the line (the clipboard stays) |
| Cmd+/ | Comment (as in WebStorm) |
| Cmd+D | Select the word at the caret; again: add a selection at its next occurrence (whole word, case sensitive; from a selection you made: any case, inside words too), wrapping, none once all are selected. Typing (Insert mode) types over every selection and goes on at every caret; from Normal mode they are Visual selections (`c`, `d` act on each). Each caret is drawn like the caret |
| Cmd+K Cmd+D | Skip: move the newest selection on to the next occurrence |
| Alt+click | Add a caret there (on a caret: remove it); while typing, typing goes on at every caret |
| Esc | One caret again (Vim mode on: Insert / Visual mode ends first, then one caret; Vim mode off: one caret, still typing). One Cmd+Z / `u` takes back an edit made at every caret |
| F12 / Shift+F12 | Go to definition / Find usages |
| F2 | Rename |
| Cmd+. | Quick fix (Alt+Enter's list) |
| Cmd+Shift+O / Cmd+T | Go to symbol in the file / in the workspace |
| Ctrl+- / Ctrl+Shift+- | Back / Forward |
| Ctrl+` (Swedish Ctrl+Shift+´) | The bottom panel's Terminal; again, the panel hides |
| Cmd+Shift+E / Ctrl+Shift+G | Project tree (as Cmd+1) / Git tool window (focus, hide when focused; Cmd+Shift+G stays Find Previous) |
| Cmd+Shift+F | Find in files |
| Cmd+W | Close the tab |
| Cmd+K Cmd+S | Key help (`,?`); Cmd+K waits for the second key as long as it takes |
| Cmd+Alt+S / Cmd+Alt+F / Cmd+Alt+R | Save all / Replace / Reveal in Finder |
| Ctrl+Shift+Cmd+Right / Left | Extend / shrink the selection |
| Cmd+Alt+Left / Right | Previous / next editor tab (Ctrl+Cmd+Left / Right too, as under every Feel) |

The window looks like VS Code's too: an Activity bar at the left (Explorer shows / hides the Project tree, Search opens Find in Files, Source Control the Git tool window), the file's path and the symbol at the caret as breadcrumbs under each split's tabs (not on the status bar), Problems in the bottom panel, and the Project tree's letters with each file's problem count (`2, M`; red with an error, yellow with warnings, a `•` on a folder holding some).

## Vim mode off

`editor.vim: false` (the Feels `webstorm` and `vscode` set it; Settings › Editor › Vim › Vim mode) turns the Vim keys off: a file you can edit is always typing, as in WebStorm without IdeaVim or VS Code. Arrows move, Shift+arrows and the mouse select (typing replaces the selection, Cmd+C / Cmd+X / Backspace act on it), Cmd+A selects everything, Esc closes the hover or error popup and keeps typing, `:` types (Command mode is Cmd+Shift+A, WebStorm's Find Action; Cmd+Shift+P under `vscode`). The WebStorm keys (or VS Code's chords under `vscode`) are the same. The status bar's segment says `VIMSTORM` with no mode. A read-only view stays in Normal mode with the arrows moving. `editor.vim: true` brings every Vim key back exactly.

Under vscode, Cmd+K is only the first key of a chord, so Commit and Push are in the right-click menu (Cmd+Alt+K still commits and pushes).

Your own keys: `abe settings import vscode|webstorm|vim` brings VS Code's `keybindings.json`, WebStorm's keymap and Vim's Ctrl / Cmd / F-key mappings into your `keys.json` where they run one of VimStorm's actions (Go to File, Find in Files, Save All, Rename, Reformat, Commit …; `--dry-run` lists each with why not). Each such key does that action under every Feel while the editor has the keyboard; two-key chords, keys that type, and keys the window keeps (Cmd+Q, Cmd+2, Cmd+E …) are not taken.

## Feel vim: stock Vim keys and your own nvim config

With the Feel `vim` (`abe settings set ui.feel vim`; importing a `.vimrc`, `init.lua` or IdeaVim picks it) the editor has Vim's own keys: `h` `j` `k` `l` and the arrows move, `,` repeats `f` / `t` backwards, the leader is Vim's `\` unless your config sets one, and none of the keys below (from .ideavimrc) nor VimStorm's `,` leader keys are there. The WebStorm Cmd keys above and the app's (⌘1 ⌘2 ⌘3 ⌘4 ⌘J, ⌃⌘← ⌃⌘→, the rail's, ⇧⇧, ⌘, …, the menu bar's) stay. Your own `~/.config/nvim` (its `init.lua` or `init.vim`, `lua/`, `plugin/`, `after/`, `colors/`) loads on top: it may set keys, options, a colorscheme; its own `lua/` modules come first for its requires. Plugins it declares with lazy.nvim or packer load from where your own Neovim installed them (VimStorm installs none); one balloon names what did not load: not installed, VimStorm's own plugin, or one that draws what VimStorm draws (noice, lualine, bufferline, neo-tree, nvim-tree, which-key, nvim-notify, nvim-cmp). A `~/.config/nvim` that is VimStorm's own `nvim/` (the plain `nvim` link above, any checkout) is left out, said in one line. Vim mode turned on under `webstorm` or `vscode` (`editor.vim: true`, VSCodeVim's import does that) has the same stock Vim keys, without your config.

Under `vimstorm` and `vim` the personal Layer's `nvim/` (`~/.config/abe/nvim`, `$ABE_CONFIG_DIR/nvim`) loads last, after VimStorm's config and your own, the same way: VimStorm's own config of yours. An error in either config is an error balloon, never fatal: what loaded stays, the editor and the app's surfaces keep working. Your config loads once VimStorm's plugins are up, over their keys. Switching the Feel takes it off again (its keys, buffers' keys too, options, autocmds, commands, colorscheme and highlights); plugins it loaded stay loaded until the project opens again (a balloon says so), and a language server it started keeps running. VimStorm's `,` shortcuts some menus and tooltips name are not there under stock Vim keys.

## Vim keys (Feel vimstorm)

`k` `l` `ö` `ä` = left / up / down / right, capitals move 5. `§` / `°` = end / start of line. `s` = search. Leader is `,`. Deletes and changes (`d` `x` `c` `D` `C` `S`, Delete) go to register `z` (`,p` pastes them), yank/paste use the clipboard; typing over selected text (a field, a snippet placeholder) leaves the clipboard alone too. `,?` lists all leader keys.

With `/` (or `::`) typed or an operator pending (`d`), a move elsewhere still goes there, as in WebStorm with its Find bar open: a tab, the tree, ⌃Tab, Go to File's or a picker's pick, Problems, a click into Git or a diff, a Chat file link, ⌥⌘← / ⌥⌘→ and the other keys that work from anywhere (⌘O, ⌘⇧F, ⌘S, ⌘K…). Neovim leaves the line first as Esc would (a search cancelled: the caret back, the last pattern kept; the `d` dropped), Insert / Visual mode too; a move that still fails says why in a balloon.
