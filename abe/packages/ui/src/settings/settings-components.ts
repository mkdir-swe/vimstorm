/**
 * The Settings dialog's components (2.1 #108, canvas page 8: T-Appearance's frame and tree,
 * T-Agents' rows, S-Search, S-Problems). The dialog is a layer (`settings.ts`), drawn by the shell
 * centred over everything at 1040 × 700 (`app/src/factory/settings.rs`); everything it shows is
 * one of these, its own popups (the combo's list, ⌘⏎'s propose popup) inside its tree.
 *
 * SettingsDialog holds the title, the search field over the tree, the footer and which part has
 * the keys; its children are the SettingsTree, the SettingsPage and an optional SettingsPropose
 * (S-Propose: ⌘⏎'s popup, a pull request for the repo). A
 * page holds SettingsGroups of SettingRows, or ProblemRows, SettingsNotes and a SettingsEmpty. A
 * row's `control` is one of a few kinds; a later page adds a kind (a theme cell, a token row, a
 * key row) here and a draw arm in Rust, never a new dialog.
 */
import { z } from 'zod';
import type { Node } from '../runtime/components';

/** A line's colour: dim (the default), warn, bad, the accent, WebStorm's modified blue. */
export const SETTINGS_TONES = ['dim', 'warn', 'bad', 'accent', 'link'] as const;
export type SettingsTone = (typeof SETTINGS_TONES)[number];

/** Which part of the dialog has the keys: `close` the footer's Close. */
export const SETTINGS_FOCUS = ['tree', 'page', 'search', 'close'] as const;
export type SettingsFocus = (typeof SETTINGS_FOCUS)[number];

/** A button the dialog draws (Retry, Undo): a click names its id. */
export type SettingsButton = { id: string; label: string };

/** A field's width by what it holds (#345). */
export const FIELD_SIZES = ['number', 'short', 'free', 'path'] as const;
export type FieldSize = (typeof FIELD_SIZES)[number];

/** One item of a list setting: its words, its detail dim after (a check's command), greyed. */
export type ListItem = { text: string; detail?: string | undefined; off?: boolean | undefined };

/** Where a change of yours goes: the repo's file, yours on this Mac, yours for this repo. */
export const SETTING_SCOPES = ['repo', 'yours', 'local'] as const;
export type SettingScopeWord = (typeof SETTING_SCOPES)[number];

/** One choice of a combo's open list: greyed with why (`not in the repo's allowedModels`). */
export type ComboChoice = { id: string; text: string; greyed?: string | undefined };

/** What a row's value is drawn with: WebStorm's controls (T-Agents, T-Appearance). */
export type SettingControl =
  /** A checkbox row: the label is the checkbox's own; `fixed` greys it (a fixed row). */
  | { kind: 'checkbox'; on: boolean; fixed?: boolean | undefined }
  /** A combo; `open`: its list under it, the cursor's choice selected, `filter` as typed. */
  | {
      kind: 'combo';
      value: string;
      open?: { choices: ComboChoice[]; cursor: number; filter: string } | undefined;
    }
  /** A segmented pick; `editing`: it has the keys (k / ä move `on`). */
  | { kind: 'segmented'; choices: string[]; on: string; editing?: boolean | undefined }
  /**
   * A text or number field; `editing`: it has the caret at the end of `text`. `size` (#345): its
   * width by what it holds, WebStorm's (`number` 72, `short` 120, `free` 240, `path` 360); `unit`
   * dim after a number's field (`px`, `min`).
   */
  | {
      kind: 'field';
      text: string;
      editing?: boolean | undefined;
      size?: FieldSize | undefined;
      unit?: string | undefined;
    }
  /**
   * A list setting: its items as chips while closed; `open` (⏎) one line per item with its ✕ and
   * ↑ ↓ (clicks `settings:item-remove:<i>`, `settings:item-up:<i>`, `settings:item-down:<i>`, an
   * item `settings:item:<i>`), then `+ Add` (`settings:item-add`, `cursor` = items' length);
   * `field`: an item typed in place (`at` null: a new one). `browse`: its items are folders, `+ Add`
   * has a Choose… button (the system's folder panel).
   */
  | {
      kind: 'list';
      items: ListItem[];
      browse?: SettingsButton | undefined;
      open?:
        { cursor: number; field?: { at: number | null; text: string } | undefined } | undefined;
    }
  /** A folder: its 360 field, then Choose… (`browse`: the system's folder panel). */
  | { kind: 'path'; text: string; editing?: boolean | undefined; browse: SettingsButton }
  /** A token or password: never its text, `•` per character typed; `set`: one is set. */
  | { kind: 'secret'; set: boolean; editing?: boolean | undefined; typed?: number | undefined }
  /** Advanced: a value no plainer control holds, as JSON in a code field. */
  | { kind: 'advanced'; text: string; editing?: boolean | undefined }
  /**
   * A setting of records (`views`, `environments`): a header of its fields (`size` each one's
   * share of the width, `pick` a field picked from a list), then a line of cells per record. `open`
   * (⏎): the cursor on a cell (`row` = the rows' count: `+ Add`), `field` that cell typed in place,
   * `pick` its list open; clicks `settings:cell:<row>:<col>`, `settings:record-remove:<row>`,
   * `settings:record-add`, `settings:choice:<i>`.
   */
  | {
      kind: 'records';
      columns: RecordColumn[];
      rows: string[][];
      open?:
        | {
            row: number;
            col: number;
            field?: { text: string } | undefined;
            pick?: { choices: ComboChoice[]; cursor: number; filter: string } | undefined;
          }
        | undefined;
    }
  /** A value as text (a fixed line, a table's summary until its page draws it). */
  | { kind: 'value'; text: string }
  /**
   * Appearance's theme list (#108 S4, T-Appearance): a preview cell per theme drawn from its own
   * colours, `on` the theme shown (picked or being saved); `cursor`: ⏎ opened it, k / ä move it.
   */
  | { kind: 'themes'; themes: ThemeCell[]; on: string; cursor?: number | undefined }
  /**
   * A colour token's row in Colours (T-Colours): its 14 px swatch and hex; `editing`: the hex is
   * a colour field with the caret (`text` as typed).
   */
  | { kind: 'colour'; hex: string; editing?: boolean | undefined; text?: string | undefined };
export type SettingControlKind = SettingControl['kind'];

/** A records control's field: its label over its cells, its share of the width. */
export type RecordColumn = { label: string; size: number; pick?: boolean | undefined };

/** One theme's preview cell: a mini window in its own colours, its name and source under it. */
export type ThemeCell = {
  slug: string;
  name: string;
  /** `built-in · current`, `yours`. */
  source: string;
  /** The colours the cell draws with, `#rrggbb` (its tokens'). */
  colors: {
    frame: string;
    panel: string;
    editor: string;
    text: string;
    dim: string;
    accent: string;
    selection: string;
    needsYou: string;
    good: string;
    border: string;
  };
};
export type SettingsDialog = {
  kind: 'SettingsDialog';
  id?: string | undefined;
  props: {
    title: string;
    /** The search field over the tree: `Search settings` until typed, `/` at its right. */
    search: { text: string };
    /** The footer's dim line at the left (`Saved Idle stop · ⌘Z undoes`). */
    note: string;
    noteTone?: SettingsTone | undefined;
    focus: SettingsFocus;
    /** ⌘A: the text of the field with the caret is selected (the next key types over it). */
    selectAll?: boolean | undefined;
    /** ⌘Z's button in the footer once a change is saved: the last save taken back. */
    undo?: SettingsButton | undefined;
  };
  /** The SettingsTree, the SettingsPage, then a SettingsPropose while one proposes. */
  children: Node[];
};

/** One row of the tree as drawn (folded groups' children left out). */
export type SettingsTreeRow = {
  id: string;
  label: string;
  depth: number;
  /** A group's chevron. */
  fold?: 'open' | 'closed' | undefined;
  /** Dim after the name (`Logins & tools  2`, a search's hits), warn for `Problems · 2`. */
  count?: { text: string; tone: SettingsTone } | undefined;
  /** The page shown. */
  selected?: boolean | undefined;
  /** Greyed: no hit while searching. */
  dim?: boolean | undefined;
  /** A change on its page is being saved: its name in the modified blue. */
  modified?: boolean | undefined;
  /** A 1 px rule under it (after Problems). */
  separator?: boolean | undefined;
};

export type SettingsTree = {
  kind: 'SettingsTree';
  id?: string | undefined;
  props: { nodes: SettingsTreeRow[] };
};

export type SettingsPage = {
  kind: 'SettingsPage';
  id?: string | undefined;
  props: {
    /** The crumb: `Appearance & Behavior`, `Appearance` (the last one current). */
    crumbs: string[];
    /** Dim after the crumb: `acme/demo-shop`, a search's `5 settings on 3 pages`. */
    scope: string;
    /** The child that holds the focused row: the shell scrolls it into view. */
    reveal?: string | undefined;
  };
  children: Node[];
};

/** A group of rows: its 11 px uppercase caption (none on a page with one group), a 1 px rule above. */
export type SettingsGroup = {
  kind: 'SettingsGroup';
  id?: string | undefined;
  props: {
    caption?: string | undefined;
    note?: string | undefined;
    /** Drawn with no rule above and no padding: Colours' token groups, a row under the last. */
    tight?: boolean | undefined;
  };
  children: Node[];
};

/**
 * One setting: the label, its value first in its control, the source line dim under it. A click
 * on the row names its id (it focuses the row); the shell makes the control's parts their own hit
 * areas, each named `<id>:<part>` and acting at once: `press` the control (a ProblemRow's and a
 * CheckRow's button too), `choice:<i>` a segment or a theme cell, `cell:<r>:<c>` a cell of records
 * not open.
 */
export type SettingRow = {
  kind: 'SettingRow';
  id?: string | undefined;
  props: {
    label: string;
    control: SettingControl;
    /** Dim beside the control (`px · 320 to 640 by dragging its edge`). */
    help?: string | undefined;
    /** Where the value comes from: `Repo`, `Yours`, `fixed · why`; `lock` draws a lock. */
    source: { text: string; tone?: SettingsTone | undefined; lock?: boolean | undefined };
    /** Where a change of yours goes, a tag after the label: `repo`, `yours`, `local`. */
    scope?: SettingScopeWord | undefined;
    /** The built-in value, dim on the source line: `default 30`. */
    default?: string | undefined;
    /** Reset to default (⌫), at the source line's end while yours sets it. */
    reset?: SettingsButton | undefined;
    /** Dim at the right while focused: `⏎ change for me · ⌘⏎ propose for the repo`. */
    hint?: string | undefined;
    focused?: boolean | undefined;
    /** `/` finds it on a page picked while searching (#152): its label marked as a search match. */
    hit?: boolean | undefined;
    /** Changed, its save not read back yet: the modified bar and label. */
    changed?: boolean | undefined;
    /** A change refused, in bad under the row: nothing saved. */
    error?: string | undefined;
    /** A 2.0 Layer Override asks its reason in place: `Reason (required)` until typed. */
    reason?: { text: string; error?: string | undefined } | undefined;
    /** The open pull request proposing it (S3): `PR #14 open`, in the accent after the source. */
    pr?: string | undefined;
  };
};

/** One problem: what is wrong, where (dim), the way out at the right (`fix… ⏎`, `open ⏎`). */
export type ProblemRow = {
  kind: 'ProblemRow';
  id?: string | undefined;
  props: {
    text: string;
    where: string;
    way: { label: string; tone?: SettingsTone | undefined };
    /** An info row, not a problem (#168: your Override): the info icon, not the warning. */
    info?: boolean | undefined;
    focused?: boolean | undefined;
  };
};

/** A dim line on a page (`No other problems`). */
export type SettingsNote = {
  kind: 'SettingsNote';
  id?: string | undefined;
  props: { text: string };
};

/** A page with nothing to list: `Nothing to set here yet`, serve down with Retry, no match. */
export type SettingsEmpty = {
  kind: 'SettingsEmpty';
  id?: string | undefined;
  props: { title: string; line?: string | undefined; action?: SettingsButton | undefined };
};

/** Which part of the propose popup has the keys. */
export const PROPOSE_FOCUS = ['value', 'reason', 'cancel', 'open'] as const;
export type ProposeFocus = (typeof PROPOSE_FOCUS)[number];

/**
 * ⌘⏎'s popup over the dialog (S-Propose): `Propose for repo acme/demo-shop`, the setting's value
 * now (dim) → the one proposed, the reason the repo's people will read (required), Cancel · Open
 * pull request ⏎, and where the pull request opens.
 */
export type SettingsPropose = {
  kind: 'SettingsPropose';
  id?: string | undefined;
  props: {
    title: string;
    label: string;
    /**
     * The value now and the one proposed: `pick` a combo (↑ ↓ change it), `toggle` a checkbox
     * (Space), `field` a text field with the caret while focused, `fixed` a value the dialog
     * put together (the repo's profiles with yours added).
     */
    value: { kind: 'pick' | 'toggle' | 'field' | 'fixed'; from: string; to: string };
    reason: { text: string; error?: string | undefined };
    focus: ProposeFocus;
    /** Refused, in bad over the buttons; `busy`: the pull request is being opened. */
    error?: string | undefined;
    busy?: boolean | undefined;
    /** `opens a pull request on this repo · abe.yaml`. */
    where: string;
    cancel: SettingsButton;
    open: SettingsButton;
  };
};

/**
 * A login or a tool on Logins & tools (S-Logins): its name, what the check found (dim), the check
 * as it runs (dim), and `✓ OK` or the problem with `fix… ⏎` at the right.
 */
export type CheckRow = {
  kind: 'CheckRow';
  id?: string | undefined;
  props: {
    label: string;
    value?: string | undefined;
    check: string;
    state: { text: string; tone?: SettingsTone | undefined };
    /** `fix…`: ⏎ types the fix into the strip; `queued`: it waits there. */
    way?: string | undefined;
    focused?: boolean | undefined;
  };
};

/**
 * The fix strip under Logins & tools' page (S-Logins): `fix · AWS SSO`, its state (`queued · ⏎
 * runs it`), the folder, the command as typed; its child the Terminal running it once you ⏎.
 */
export type SettingsFix = {
  kind: 'SettingsFix';
  id?: string | undefined;
  props: {
    title: string;
    state: string;
    stateTone?: SettingsTone | undefined;
    cwd?: string | undefined;
    command: string;
    note: string;
  };
  children: Node[];
};

export type SettingsNode =
  | SettingsDialog
  | SettingsTree
  | SettingsPage
  | SettingsGroup
  | SettingRow
  | ProblemRow
  | SettingsNote
  | SettingsEmpty
  | SettingsPropose
  | CheckRow
  | SettingsFix;

export const SETTINGS_KINDS = [
  'SettingsDialog',
  'SettingsTree',
  'SettingsPage',
  'SettingsGroup',
  'SettingRow',
  'ProblemRow',
  'SettingsNote',
  'SettingsEmpty',
  'SettingsPropose',
  'CheckRow',
  'SettingsFix',
] as const;

/** The schemas, on the set's own primitives (`components.ts` calls this). */
export const settingsSchemas = (d: { nodeId: z.ZodString; node: () => z.ZodType<Node> }) => {
  const id = d.nodeId.optional();
  const tone = z.enum(SETTINGS_TONES);
  const button = z.strictObject({ id: d.nodeId, label: z.string().min(1) });
  const control = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('checkbox'), on: z.boolean(), fixed: z.boolean().optional() }),
    z.strictObject({
      kind: z.literal('combo'),
      value: z.string(),
      open: z
        .strictObject({
          choices: z.array(
            z.strictObject({ id: d.nodeId, text: z.string(), greyed: z.string().optional() }),
          ),
          cursor: z.number().int().nonnegative(),
          filter: z.string(),
        })
        .optional(),
    }),
    z.strictObject({
      kind: z.literal('segmented'),
      choices: z.array(z.string()),
      on: z.string(),
      editing: z.boolean().optional(),
    }),
    z.strictObject({
      kind: z.literal('field'),
      text: z.string(),
      editing: z.boolean().optional(),
      size: z.enum(FIELD_SIZES).optional(),
      unit: z.string().optional(),
    }),
    z.strictObject({ kind: z.literal('value'), text: z.string() }),
    z.strictObject({
      kind: z.literal('themes'),
      themes: z.array(
        z.strictObject({
          slug: z.string(),
          name: z.string(),
          source: z.string(),
          colors: z.strictObject({
            frame: z.string(),
            panel: z.string(),
            editor: z.string(),
            text: z.string(),
            dim: z.string(),
            accent: z.string(),
            selection: z.string(),
            needsYou: z.string(),
            good: z.string(),
            border: z.string(),
          }),
        }),
      ),
      on: z.string(),
      cursor: z.number().int().optional(),
    }),
    z.strictObject({
      kind: z.literal('colour'),
      hex: z.string(),
      editing: z.boolean().optional(),
      text: z.string().optional(),
    }),
    z.strictObject({
      kind: z.literal('list'),
      items: z.array(
        z.strictObject({
          text: z.string(),
          detail: z.string().optional(),
          off: z.boolean().optional(),
        }),
      ),
      browse: button.optional(),
      open: z
        .strictObject({
          cursor: z.number().int().nonnegative(),
          field: z
            .strictObject({ at: z.number().int().nonnegative().nullable(), text: z.string() })
            .optional(),
        })
        .optional(),
    }),
    z.strictObject({
      kind: z.literal('path'),
      text: z.string(),
      editing: z.boolean().optional(),
      browse: button,
    }),
    z.strictObject({
      kind: z.literal('secret'),
      set: z.boolean(),
      editing: z.boolean().optional(),
      typed: z.number().int().nonnegative().optional(),
    }),
    z.strictObject({
      kind: z.literal('advanced'),
      text: z.string(),
      editing: z.boolean().optional(),
    }),
    z.strictObject({
      kind: z.literal('records'),
      columns: z.array(
        z.strictObject({
          label: z.string(),
          size: z.number().int().positive(),
          pick: z.boolean().optional(),
        }),
      ),
      rows: z.array(z.array(z.string())),
      open: z
        .strictObject({
          row: z.number().int().nonnegative(),
          col: z.number().int().nonnegative(),
          field: z.strictObject({ text: z.string() }).optional(),
          pick: z
            .strictObject({
              choices: z.array(
                z.strictObject({ id: d.nodeId, text: z.string(), greyed: z.string().optional() }),
              ),
              cursor: z.number().int().nonnegative(),
              filter: z.string(),
            })
            .optional(),
        })
        .optional(),
    }),
  ]);
  const children = () => z.array(d.node());

  return [
    z.strictObject({
      kind: z.literal('SettingsDialog'),
      id,
      props: z.strictObject({
        title: z.string(),
        search: z.strictObject({ text: z.string() }),
        note: z.string(),
        noteTone: tone.optional(),
        focus: z.enum(SETTINGS_FOCUS),
        selectAll: z.boolean().optional(),
        undo: button.optional(),
      }),
      get children() {
        return children();
      },
    }),
    z.strictObject({
      kind: z.literal('SettingsTree'),
      id,
      props: z.strictObject({
        nodes: z.array(
          z.strictObject({
            id: d.nodeId,
            label: z.string(),
            depth: z.number().int().nonnegative(),
            fold: z.enum(['open', 'closed']).optional(),
            count: z.strictObject({ text: z.string(), tone }).optional(),
            selected: z.boolean().optional(),
            dim: z.boolean().optional(),
            modified: z.boolean().optional(),
            separator: z.boolean().optional(),
          }),
        ),
      }),
    }),
    z.strictObject({
      kind: z.literal('SettingsPage'),
      id,
      props: z.strictObject({
        crumbs: z.array(z.string()),
        scope: z.string(),
        reveal: d.nodeId.optional(),
      }),
      get children() {
        return children();
      },
    }),
    z.strictObject({
      kind: z.literal('SettingsGroup'),
      id,
      props: z.strictObject({
        caption: z.string().optional(),
        note: z.string().optional(),
        tight: z.boolean().optional(),
      }),
      get children() {
        return children();
      },
    }),
    z.strictObject({
      kind: z.literal('SettingRow'),
      id,
      props: z.strictObject({
        label: z.string(),
        control,
        help: z.string().optional(),
        source: z.strictObject({
          text: z.string(),
          tone: tone.optional(),
          lock: z.boolean().optional(),
        }),
        scope: z.enum(SETTING_SCOPES).optional(),
        default: z.string().optional(),
        reset: button.optional(),
        hint: z.string().optional(),
        focused: z.boolean().optional(),
        hit: z.boolean().optional(),
        changed: z.boolean().optional(),
        error: z.string().optional(),
        reason: z.strictObject({ text: z.string(), error: z.string().optional() }).optional(),
        pr: z.string().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('ProblemRow'),
      id,
      props: z.strictObject({
        text: z.string(),
        where: z.string(),
        way: z.strictObject({ label: z.string(), tone: tone.optional() }),
        info: z.boolean().optional(),
        focused: z.boolean().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('SettingsNote'),
      id,
      props: z.strictObject({ text: z.string() }),
    }),
    z.strictObject({
      kind: z.literal('SettingsEmpty'),
      id,
      props: z.strictObject({
        title: z.string(),
        line: z.string().optional(),
        action: button.optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('SettingsPropose'),
      id,
      props: z.strictObject({
        title: z.string(),
        label: z.string(),
        value: z.strictObject({
          kind: z.enum(['pick', 'toggle', 'field', 'fixed']),
          from: z.string(),
          to: z.string(),
        }),
        reason: z.strictObject({ text: z.string(), error: z.string().optional() }),
        focus: z.enum(PROPOSE_FOCUS),
        error: z.string().optional(),
        busy: z.boolean().optional(),
        where: z.string(),
        cancel: button,
        open: button,
      }),
    }),
    z.strictObject({
      kind: z.literal('CheckRow'),
      id,
      props: z.strictObject({
        label: z.string(),
        value: z.string().optional(),
        check: z.string(),
        state: z.strictObject({ text: z.string(), tone: tone.optional() }),
        way: z.string().optional(),
        focused: z.boolean().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('SettingsFix'),
      id,
      props: z.strictObject({
        title: z.string(),
        state: z.string(),
        stateTone: tone.optional(),
        cwd: z.string().optional(),
        command: z.string(),
        note: z.string(),
      }),
      get children() {
        return children();
      },
    }),
  ] as const;
};
