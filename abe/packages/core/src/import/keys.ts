/**
 * Imported keys (#129): another editor's key bindings onto the Keymap catalogue (`keymap.ts`). A
 * binding whose command is one of VimStorm's actions becomes `<key> → <action>` in your Layer's
 * `keys.json`; one with a key VimStorm cannot bind (two keys, a key the window keeps) or a command
 * it has none of stays `no match here`.
 */
import {
  bindable,
  chordText,
  type KeymapActionId,
  KEYMAP_ACTIONS,
  type ReadKey,
  WINDOW_KEYS,
} from '../theme/keymap';
import { type ImportRow } from './contract';
import { clip } from './rows';

/** VS Code's command ids for the catalogue's actions. */
const VSCODE_COMMANDS: Readonly<Record<string, KeymapActionId>> = {
  'workbench.action.quickOpen': 'goToFile',
  'workbench.action.findInFiles': 'findInFiles',
  'workbench.view.search': 'findInFiles',
  'actions.find': 'find',
  'editor.action.startFindReplaceAction': 'replace',
  'workbench.action.files.save': 'saveAll',
  'workbench.action.files.saveAll': 'saveAll',
  'workbench.action.openRecent': 'recentProjects',
  'workbench.view.explorer': 'projectTree',
  'workbench.action.toggleSidebarVisibility': 'projectTree',
  'workbench.action.terminal.new': 'newTerminal',
  'editor.action.revealDefinition': 'goToDeclaration',
  'editor.action.goToDeclaration': 'goToDeclaration',
  'editor.action.peekDefinition': 'quickDefinition',
  'editor.action.rename': 'rename',
  'editor.action.formatDocument': 'reformat',
  'editor.action.quickFix': 'contextActions',
  'editor.action.commentLine': 'commentLine',
  'editor.action.copyLinesDownAction': 'duplicate',
  'editor.action.duplicateSelection': 'duplicate',
  'editor.action.smartSelect.expand': 'extendSelection',
  'editor.action.smartSelect.shrink': 'shrinkSelection',
  'workbench.action.nextEditor': 'nextTab',
  'workbench.action.previousEditor': 'previousTab',
  'git.commit': 'commit',
  'git.push': 'push',
  revealFileInOS: 'revealInFinder',
  'git.revertSelectedRanges': 'rollbackLines',
};

/** JetBrains' action ids for the catalogue's actions. */
const JETBRAINS_ACTIONS: Readonly<Record<string, KeymapActionId>> = {
  GotoFile: 'goToFile',
  FindInPath: 'findInFiles',
  Find: 'find',
  Replace: 'replace',
  SaveAll: 'saveAll',
  ManageRecentProjects: 'recentProjects',
  RecentProjectListGroup: 'recentProjects',
  ActivateProjectToolWindow: 'projectTree',
  GotoDeclaration: 'goToDeclaration',
  QuickImplementations: 'quickDefinition',
  RenameElement: 'rename',
  ReformatCode: 'reformat',
  ShowIntentionActions: 'contextActions',
  CommentByLineComment: 'commentLine',
  EditorDuplicate: 'duplicate',
  EditorSelectWord: 'extendSelection',
  EditorUnSelectWord: 'shrinkSelection',
  NextTab: 'nextTab',
  PreviousTab: 'previousTab',
  CheckinProject: 'commit',
  'Vcs.Push': 'push',
  RevealIn: 'revealInFinder',
  'Vcs.RollbackChangedLines': 'rollbackLines',
};

/** What a Vim mapping's right-hand side does, by the plugin or command it runs. */
const VIM_COMMANDS: readonly (readonly [RegExp, KeymapActionId])[] = [
  [
    /find_files|:Files\b|:GFiles\b|FzfLua\s+files|fzf-lua.*\bfiles\b|Snacks\.picker\.files/,
    'goToFile',
  ],
  [/live_grep|:Rg\b|:Ag\b|FzfLua\s+live_grep|Snacks\.picker\.grep/, 'findInFiles'],
  [/^(?::|<cmd>)\s*(?:w|wa|wall|up|update)!?\s*<cr>$/i, 'saveAll'],
  [/NvimTree(?:Find(?:File)?)?Toggle|NERDTreeToggle|Neotree|Snacks\.explorer/, 'projectTree'],
  [/lsp\.buf\.definition|lsp_definitions/, 'goToDeclaration'],
  [/lsp\.buf\.rename/, 'rename'],
  [/lsp\.buf\.format|conform.*format/, 'reformat'],
  [/lsp\.buf\.code_action/, 'contextActions'],
];

export const vscodeAction = (command: string): KeymapActionId | undefined =>
  VSCODE_COMMANDS[command];

export const jetbrainsAction = (id: string): KeymapActionId | undefined => JETBRAINS_ACTIONS[id];

/**
 * A JetBrains action id in words (#325): the Keymap's title for one of its actions, else the id's
 * words (`EditorCloneCaretBelow` is Clone Caret Below, `Vcs.Push` Vcs Push).
 */
export const jetbrainsActionWords = (id: string): string => {
  const ours = jetbrainsAction(id);

  if (ours !== undefined) return KEYMAP_ACTIONS[ours].title;
  const words = id.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [];
  // the editor's own actions are named for it: Editor Duplicate is Duplicate
  const named = words[0] === 'Editor' && words.length > 1 ? words.slice(1) : words;

  return named.length === 0 ? id : named.join(' ');
};

export const vimAction = (rhs: string): KeymapActionId | undefined =>
  VIM_COMMANDS.find(([re]) => re.test(rhs.trim()))?.[1];

/** The most of a source's line a row shows. */
const FROM = 120;

/**
 * A key binding's row: `<key> → <action>` (ticked) when its key is one VimStorm binds and its
 * command one of the catalogue's; else `no match here` with why.
 */
export const keyRow = (
  id: string,
  from: string,
  key: ReadKey,
  action: KeymapActionId | undefined,
  what: string,
  /** What a match leaves out (VS Code's `when`). */
  leaves: string | null = null,
): ImportRow => {
  const row = { id, group: 'keys' as const, from: clip(from, FROM), to: null, bind: null };

  if ('none' in key) return { ...row, note: key.none, ticked: false };
  const text = chordText(key.chord);

  if (!bindable(key.chord))
    return {
      ...row,
      note: `no match here: ${text} types (VimStorm binds ⌃ / ⌘ keys, F-keys and ⌥ with a named key)`,
      ticked: false,
    };
  if (action === undefined)
    return { ...row, note: `no match here: VimStorm has no ${what}`, ticked: false };
  if (WINDOW_KEYS.includes(text))
    return {
      ...row,
      note: `no match here: ${text} is VimStorm's own (${KEYMAP_ACTIONS[action].title} keeps ${KEYMAP_ACTIONS[action].key})`,
      ticked: false,
    };
  // the key is one of VimStorm's own for another action: yours wins in the editor
  const covered = Object.values(KEYMAP_ACTIONS).find(
    (a) => a.key === text && a !== KEYMAP_ACTIONS[action],
  );
  const notes = [leaves, covered === undefined ? null : `covers ${text} ${covered.title}`].filter(
    (n) => n !== null,
  );

  return {
    ...row,
    bind: { key: text, action },
    note: notes.length === 0 ? null : notes.join(' · '),
    ticked: true,
  };
};
