/**
 * The Settings dialog's catalogue (#108): the tree, WebStorm-deep, and each page's rows in order.
 * Pure data and lookups; the dialog draws it, `abe settings list` fills each row's value and
 * source, search matches over it.
 *
 * A row is one setting (`key`), one field of an object setting (`key` + `field`: `board`'s
 * `done`), a fixed line with no setting (`fixed`: who fixed it and why), or a table or preview
 * the dialog fills from elsewhere (`key` null, `fixed` null: Logins & tools, Layers, Keymap).
 * Every setting has its home rows on exactly one page (#345: one home per setting); a link row
 * (`link`) on another page names a home row and shows its value, ⏎ goes there (Appearance's
 * `Editor font · Editor › Font`), never a second control for the same setting.
 */
import { BOX_SIZES } from '../../box/box-sizes';
import { PIPELINE_PROVIDERS, PROVIDER_TITLE } from '../../board/pipelines';
import {
  AUTO_SAVES,
  DENSITIES,
  EFFORTS,
  FEEL_WORDS,
  FEELS,
  isMachineSetting,
  isMineSetting,
  SERVE_TARGETS,
  SESSION_MCPS,
  type SettingKey,
  SETTINGS,
  TREE_DECORATIONS,
} from './keys';
import { takesNone } from './input';

/** The WebStorm controls a row is drawn with. */
export const CONTROLS = [
  'checkbox',
  'combo',
  'segmented',
  'text',
  'number',
  'chips',
  'table',
  'preview',
  /** A line naming another page's home row: its value, the page's path, ⏎ goes there (#345). */
  'link',
  /** A folder: its field and a Choose… button (the system's folder panel). */
  'path',
  /** A token or password: its text never drawn, only that one is set. */
  'secret',
  /** A value no plainer control holds (an object, a list of objects): its JSON, in one field. */
  'advanced',
  /** A setting of records (`views`, `environments`): rows of fields, each typed or picked. */
  'records',
] as const;
export type Control = (typeof CONTROLS)[number];

export const PAGE_IDS = [
  'problems',
  'appearance',
  'import-config',
  'keymap',
  'editor-general',
  'editor-font',
  'color-scheme',
  'vim',
  'agents',
  'board-team',
  'boxes-cloud',
  'browser-profiles',
  'factory-policy',
  'local-mode',
  'reach',
  'layers',
  'logins-tools',
  'skills',
  'version-control',
  'tools',
] as const;
export type PageId = (typeof PAGE_IDS)[number];

/**
 * A text field's width by what it holds (#345, WebStorm's forms): `short` a name (120), `free` a
 * line (240), `path` a folder (360). A number field is 72 wide, its unit after it.
 */
export const FIELD_SIZES = ['short', 'free', 'path'] as const;
export type FieldSize = (typeof FIELD_SIZES)[number];

/**
 * Where a combo's choices come from besides its own (`choices`): what serve knows on this Mac (your
 * gh logins, your AWS profiles and their regions), or the settings in force (the repo's
 * environments, the Azure DevOps organizations a Layer names, the browser profiles).
 */
export const CHOICE_SOURCES = [
  'gh-accounts',
  'aws-profiles',
  'aws-regions',
  'environments',
  'azure-orgs',
  'browser-profiles',
] as const;
export type ChoiceSource = (typeof CHOICE_SOURCES)[number];

/** A link row's target (#345): the home row it names, and the settings whose values it shows. */
export type RowLink = {
  readonly page: PageId;
  /** The home row's id on that page. */
  readonly row: string;
  /** The settings it shows, their values joined (`JetBrains Mono 13`). */
  readonly keys: readonly SettingKey[];
};

/** Who fixed a fixed row: VimStorm itself. */
export type FixedBy = 'built-in';

export type SettingRow = {
  /** Unique in the catalogue: the key, `<key>#<field>`, a fixed, table or link row's name. */
  readonly id: string;
  readonly page: PageId;
  /** The group caption it sits under (11 px uppercase), or none. */
  readonly group: string | null;
  readonly label: string;
  readonly control: Control;
  /** The dim line beside or under it. */
  readonly help: string;
  /** The setting, or `null` for a fixed row or a table filled from elsewhere. */
  readonly key: SettingKey | null;
  /** The field of an object setting this row shows (`done` of `board`), else `null`. */
  readonly field: string | null;
  /** A combo's or segmented pick's choices, when they are known here (`null`: the dialog lists them). */
  readonly choices: readonly string[] | null;
  /** Where more of a combo's choices come from (`settings list` adds them), else `null`. */
  readonly known: ChoiceSource | null;
  /**
   * A combo whose list may not hold every value (an account serve has not seen, a font): a name
   * typed into its filter is taken as it is, read as `settings set` reads it.
   */
  readonly free: boolean;
  /** No value is one (`box.profile`: the default profile): its combo offers `none` first. */
  readonly clearable: boolean;
  /**
   * Each choice in words, as the dialog's control and source lines say it (#325): `afterDelay` is
   * `after a pause`; a sentence takes them as they are, a control with its first letter capital.
   * `null`: the choices are their own words (model names, profiles).
   */
  readonly words: Readonly<Record<string, string>> | null;
  /** What no value means here, as a source line says it (`no limit`); `null`: `none`. */
  readonly none: string | null;
  /** A number's unit after its field (`px`, `min`), else `null`. */
  readonly unit: string | null;
  /** A text field's width (#345): `free` unless it holds a name or a folder. */
  readonly size: FieldSize;
  /** Yours alone (for this repo, or on this Mac): not offered for the repo. */
  readonly personalOnly: boolean;
  /** A line no setting changes: its value, who fixed it and why. */
  readonly fixed: { by: FixedBy; value: string; why: string } | null;
  /** A link row's home row elsewhere (#345), else `null`. */
  readonly link: RowLink | null;
};

export type SettingsPage = {
  readonly id: PageId;
  readonly label: string;
  /** Its path in the tree: `Appearance & Behavior › Appearance`. */
  readonly crumb: string;
  readonly rows: readonly SettingRow[];
  /** What a page with no rows says (never an empty white area). */
  readonly empty: string | null;
};

export type TreeNode = {
  readonly id: string;
  readonly label: string;
  /** Its own page; a group with none opens its first child. */
  readonly page: PageId | null;
  readonly children: readonly TreeNode[];
  /** Shown only while there are problems (`Problems · N`). */
  readonly whileProblems?: true;
};

/**
 * The settings with no row (#345): a Layer may write them, the dialog shows none. `chat.width`:
 * the drag of the Chat column's edge is the width, kept per Mac, so a row would be overruled.
 */
// credentials and testWrites: the install's Credentials stage and Data's TEST yes set them, yours for the repo
// spec.where: the install's Board stage writes it in the repo's settings
export const NO_ROW: readonly SettingKey[] = [
  'chat.width',
  'credentials',
  'testWrites',
  'spec.where',
];

/** What a page with no rows says. */
export const NOTHING_TO_SET = 'Nothing to set here yet';

// The catalogue as written: pages of groups of rows. Labels and help lines are the boards'.

type RowSpec = {
  id?: string;
  key?: SettingKey;
  field?: string;
  label: string;
  control: Control;
  help?: string;
  choices?: readonly string[];
  known?: ChoiceSource;
  free?: true;
  words?: Readonly<Record<string, string>>;
  none?: string;
  unit?: string;
  size?: FieldSize;
  fixed?: { by: FixedBy; value: string; why: string };
  link?: RowLink;
};

type GroupSpec = { caption: string | null; rows: readonly RowSpec[] };

const set = (
  key: SettingKey,
  label: string,
  control: Control,
  more: Omit<RowSpec, 'key' | 'label' | 'control'> = {},
): RowSpec => ({ key, label, control, ...more });

const field = (
  key: SettingKey,
  name: string,
  label: string,
  control: Control,
  more: Omit<RowSpec, 'key' | 'field' | 'label' | 'control'> = {},
): RowSpec => ({ key, field: name, label, control, ...more });

const table = (id: string, label: string, help: string, control: Control = 'table'): RowSpec => ({
  id,
  label,
  control,
  help,
});

/** A line on one page naming a home row on another (#345): `Editor font · Editor › Font`. */
const link = (id: string, label: string, to: RowLink, help?: string): RowSpec => ({
  id,
  label,
  control: 'link',
  link: to,
  ...(help === undefined ? {} : { help }),
});

/** A line of what local mode means (#24, LM-Setting): fixed, its words the value. */
const localLine = (id: string, label: string, value: string): RowSpec => ({
  id,
  label,
  control: 'text',
  fixed: { by: 'built-in', value, why: 'what local mode is' },
});

const MODELS = SETTINGS.allowedModels.default;

/** What turning prod on for agents says beside its toggle (ADR 0029). */
export const PROD_ON_WARNING =
  "Warning: on, this repo's agents read and write prod: its data, aws account and keys · from the next session";

/** A box size by what it gives, its AWS name after. */
const BOX_WORDS = {
  'm8g.large': '2 CPUs, 8 GB (m8g.large)',
  'm8g.xlarge': '4 CPUs, 16 GB (m8g.xlarge)',
  'm8g.2xlarge': '8 CPUs, 32 GB (m8g.2xlarge)',
  'm8g.4xlarge': '16 CPUs, 64 GB (m8g.4xlarge)',
  'm8g.8xlarge': '32 CPUs, 128 GB (m8g.8xlarge)',
  'm8g.12xlarge': '48 CPUs, 192 GB (m8g.12xlarge)',
  'm8g.16xlarge': '64 CPUs, 256 GB (m8g.16xlarge)',
} as const satisfies Record<(typeof BOX_SIZES)[number], string>;

const GROUPS: Record<PageId, readonly GroupSpec[]> = {
  problems: [],
  appearance: [
    {
      caption: 'Feel',
      rows: [
        set('ui.feel', 'Feel', 'segmented', {
          choices: FEELS,
          words: FEEL_WORDS,
          // one line (#345); the theme stays Theme's: VS Code's own is Dark Modern there
          help: 'sets Vim mode, the tree, tabs and save · never the theme (VS Code’s: Dark Modern)',
        }),
      ],
    },
    {
      caption: 'Theme',
      rows: [
        set('ui.theme', 'Theme', 'preview', { help: 'live in every window as you pick' }),
        link(
          'editor-scheme-link',
          'Editor scheme',
          { page: 'color-scheme', row: 'editor.scheme', keys: ['editor.scheme'] },
          'Editor › Color scheme',
        ),
      ],
    },
    {
      caption: 'Density',
      rows: [
        set('ui.density', 'Density', 'segmented', {
          choices: DENSITIES,
          words: { compact: 'compact', default: 'default' } satisfies Record<
            (typeof DENSITIES)[number],
            string
          >,
          help: 'Compact tightens rows, tabs and the toolbar',
        }),
      ],
    },
    {
      caption: 'Font',
      rows: [
        set('ui.font.family', 'UI font', 'combo', { free: true }),
        set('ui.font.size', 'UI font size', 'number', { unit: 'px' }),
        link(
          'editor-font-link',
          'Editor font',
          {
            page: 'editor-font',
            row: 'ui.font.editorFamily',
            keys: ['ui.font.editorFamily', 'ui.font.editorSize'],
          },
          'Editor › Font',
        ),
      ],
    },
    {
      caption: 'Chat',
      // its width is the drag of its edge (#345): no row that a drag overrules
      rows: [set('chat.openByDefault', 'Chat column open by default', 'checkbox')],
    },
    {
      caption: 'Views',
      rows: [
        set('views', 'View tweaks', 'records', {
          help: 'parts of a screen hidden, reordered or relabelled by node id',
        }),
      ],
    },
  ],
  // its rows are `abe settings import`'s (the dialog draws them), no setting of its own
  'import-config': [],
  // out of the tree until it lists the actions and their keys (#345: no empty page)
  keymap: [],
  'editor-general': [
    {
      caption: 'Project tree',
      rows: [
        set('tree.autoReveal', 'Always select the opened file', 'checkbox'),
        set('tree.singleClick', 'Open files with a single click', 'checkbox'),
        set('tree.decorations', 'Changed files', 'segmented', {
          choices: TREE_DECORATIONS,
          words: { colors: 'colours', letters: 'colours and letters' } satisfies Record<
            (typeof TREE_DECORATIONS)[number],
            string
          >,
          help: 'colours: the names coloured · and letters: M / U / D at the right as well',
        }),
        set('tree.compactFolders', 'Compact folders', 'checkbox', { help: 'a/b/c on one row' }),
      ],
    },
    {
      caption: 'Editor tabs',
      rows: [
        set('tabs.limit', 'Tab limit', 'number', {
          help: 'per split · empty: no limit',
          none: 'no limit',
        }),
        set('tabs.dirtyDot', 'Mark unsaved tabs with ●', 'checkbox'),
        set('tabs.preview', 'Preview tab', 'checkbox', {
          help: 'a single-click open replaces the italic tab',
        }),
      ],
    },
    {
      caption: 'Editor',
      rows: [
        set('editor.minimap', 'Show the minimap', 'checkbox', {
          help: 'the file in small at the right; click or drag to scroll',
        }),
      ],
    },
    {
      caption: 'Files',
      rows: [
        set('files.autoSave', 'Save files', 'combo', {
          choices: AUTO_SAVES,
          words: {
            off: 'off',
            onFocusChange: 'on leaving the file',
            afterDelay: 'after a pause',
          } satisfies Record<(typeof AUTO_SAVES)[number], string>,
          help: 'on leaving the file or the window · after a pause: a moment after you stop typing',
        }),
      ],
    },
  ],
  'editor-font': [
    {
      caption: 'Font',
      rows: [
        set('ui.font.editorFamily', 'Editor font', 'combo', {
          free: true,
          help: 'the terminal uses it too',
        }),
        set('ui.font.editorSize', 'Editor font size', 'number', { unit: 'px' }),
        set('ui.font.ligatures', 'Ligatures', 'checkbox'),
      ],
    },
  ],
  // WebStorm's split (#345): the theme is Appearance's, the editor's colours are here
  'color-scheme': [
    {
      caption: null,
      rows: [
        set('editor.scheme', 'Scheme', 'combo', {
          help: 'Same as theme follows Appearance › Theme; a named one stays when the theme changes',
        }),
      ],
    },
    // last on the page: its 260 tokens land after the rest is read, so nothing above moves (#297)
    {
      caption: 'Colours',
      rows: [
        table('colours', 'Colours', 'a change saves your copy, never the built-in', 'preview'),
      ],
    },
  ],
  vim: [
    {
      caption: null,
      rows: [
        set('editor.vim', 'Vim mode', 'checkbox', {
          help: 'off: always typing, arrows and ⇧ arrows select, no modes',
        }),
        {
          id: 'vim.leader',
          label: 'Leader',
          control: 'text',
          fixed: {
            by: 'built-in',
            value: ',',
            why: "nvim's own, set in VimStorm's nvim config, not here",
          },
        },
      ],
    },
  ],
  agents: [
    {
      caption: 'Models',
      rows: [
        set('models.coordinator', 'Coordinator', 'combo', {
          choices: MODELS,
          help: 'runs the session and decides',
        }),
        set('models.reader', 'Reader', 'combo', {
          choices: MODELS,
          help: 'subagents that only read',
        }),
        set('models.writer', 'Writer', 'combo', {
          choices: MODELS,
          help: 'subagents that change files',
        }),
        set('allowedModels', 'Allowed models', 'chips', {
          choices: MODELS,
          help: "the repo's · yours may only narrow it",
        }),
      ],
    },
    {
      caption: 'Effort',
      rows: [
        set('effort', 'New sessions', 'segmented', {
          choices: EFFORTS,
          words: { low: 'low', medium: 'medium', high: 'high' } satisfies Record<
            (typeof EFFORTS)[number],
            string
          >,
          help: 'a resumed session keeps its own',
        }),
      ],
    },
    {
      caption: 'Prototypes',
      rows: [
        set('prototype.model', 'Model', 'combo', {
          choices: MODELS,
          help: 'a prototype session · /model in one switches that prototype only',
        }),
        set('prototype.effort', 'Effort', 'segmented', {
          choices: EFFORTS,
          words: { low: 'low', medium: 'medium', high: 'high' } satisfies Record<
            (typeof EFFORTS)[number],
            string
          >,
          help: 'a new prototype session',
        }),
      ],
    },
    {
      caption: 'Subagents',
      rows: [set('subagents.max', 'At most', 'number', { help: 'at once per session' })],
    },
    {
      caption: 'Standing notes',
      rows: [
        set('launch.notes', 'Every launch', 'chips', {
          help: 'read after the card, as a Launch note; each Layer adds to the ones above',
        }),
      ],
    },
    {
      caption: 'Skills on top',
      rows: [
        set('skillsOnTop', 'My skills on top', 'checkbox', {
          help: "yours load after repo's, locally and on boxes",
        }),
      ],
    },
    {
      caption: 'Sandbox',
      rows: [
        {
          id: 'agents.sandbox',
          label: 'Local sessions',
          control: 'text',
          fixed: {
            by: 'built-in',
            value: 'Local sandbox · auto mode · always',
            why: 'no setting',
          },
        },
        set('session.mcp', "Your MCP servers, never a repo's", 'segmented', {
          choices: SESSION_MCPS,
          words: { yours: 'yours too', 'abe-only': "Abe's only" } satisfies Record<
            (typeof SESSION_MCPS)[number],
            string
          >,
          help: "a repo's own never load, in any session · MCP tools run outside the sandbox and aren't checked by Abe's fence",
        }),
        {
          id: 'agents.override-reason',
          label: 'Overrides require a reason',
          control: 'checkbox',
          fixed: {
            by: 'built-in',
            value: 'on',
            why: 'an Override always needs its reason',
          },
        },
      ],
    },
    {
      // ADR 0029: what this repo's agents reach; yours alone, for this repo, the next session
      caption: 'Environments',
      rows: [
        set('agents.dev', 'dev', 'checkbox', {
          help: "this repo's agents reach dev, read and write · applies to the next session",
        }),
        set('agents.test', 'test', 'checkbox', {
          help: "this repo's agents reach test, read and write · applies to the next session",
        }),
        set('agents.prod', 'prod', 'checkbox', {
          help: PROD_ON_WARNING,
        }),
      ],
    },
  ],
  'board-team': [
    {
      caption: 'Board',
      rows: [
        field('board', 'provider', 'Provider', 'combo', {
          choices: ['github', 'azure', 'local'],
          words: { github: 'GitHub Issues', azure: 'Azure DevOps', local: 'On this machine' },
          help: "the repo's GitHub Issues (labels active, resolved: the middle columns), Azure DevOps, or one on this machine only",
        }),
        field('board', 'repo', 'GitHub repo', 'text', {
          help: "<owner>/<name> · origin's when empty",
        }),
        field('board', 'organization', 'Organization', 'combo', {
          known: 'azure-orgs',
          free: true,
          help: 'https://dev.azure.com/<org>',
        }),
        field('board', 'project', 'Project', 'text'),
        field('board', 'team', 'Board team', 'text', { size: 'short' }),
        field('board', 'types', 'Card types', 'chips'),
        field('board', 'active', 'Building moves the card to', 'text', {
          size: 'short',
          help: "the board's state for a card being built · Active when empty",
        }),
        field('board', 'done', 'Done moves the card to', 'text', {
          size: 'short',
          help: "the board's state for a card done · Closed when empty",
        }),
        field('board', 'azureConfigDir', 'Your az login folder', 'path', {
          size: 'path',
          help: "where your az keeps its login · $AZURE_CONFIG_DIR wins · az's own when empty",
        }),
      ],
    },
    {
      caption: 'You',
      rows: [
        set('githubIdentity', 'GitHub login', 'combo', {
          known: 'gh-accounts',
          free: true,
          help: 'reviews, comments, Draft PRs and merges go as it: gh signed in as another refuses them',
        }),
        set('logins.gh', 'GitHub account', 'combo', {
          known: 'gh-accounts',
          free: true,
          none: "gh's active one",
          help: "Abe's GitHub reads and writes and its sessions' gh go as it, without switching gh · gh's active one when empty",
        }),
        set('logins.az', 'Azure account', 'combo', {
          free: true,
          help: 'your az account for this repo, a name only · logins: { az } in .abe/settings.local.yaml',
        }),
      ],
    },
    {
      caption: 'Moves',
      rows: [set('move.leave', 'Left behind on a move', 'chips')],
    },
  ],
  'boxes-cloud': [
    {
      caption: 'Boxes',
      rows: [
        set('limits.maxBoxesPerPerson', 'Max boxes per person', 'number'),
        set('box.size', 'Start size', 'combo', {
          choices: BOX_SIZES,
          words: BOX_WORDS,
          help: "a repo's new box · within the largest",
        }),
        set('limits.maxBoxSize', 'Box size', 'combo', {
          choices: BOX_SIZES,
          words: BOX_WORDS,
          help: 'the largest size one box may have',
        }),
        set('limits.maxBoxDisk', 'Largest disk', 'number', {
          unit: 'GB',
          help: 'a box disk grows by itself up to this',
        }),
        set('box.idleMinutes', 'Idle stop', 'number', {
          unit: 'min',
          help: 'with nothing running',
        }),
        set('box.waitingMinutes', 'Waiting on you', 'number', {
          unit: 'min',
          help: 'a box stays up for a session waiting on you',
        }),
      ],
    },
    {
      caption: 'Your environment',
      rows: [
        set('box.profile', 'AWS profile', 'combo', {
          known: 'aws-profiles',
          free: true,
          none: 'the default profile',
          help: '$ABE_BOX_PROFILE wins · $AWS_PROFILE, else the default profile, when empty',
        }),
        set('box.region', 'AWS region', 'combo', {
          known: 'aws-regions',
          free: true,
          none: "the profile's own",
          help: "$AWS_REGION or $AWS_DEFAULT_REGION wins · the profile's own when empty",
        }),
        set('box.owner', 'Box owner', 'combo', {
          known: 'gh-accounts',
          free: true,
          none: "gh's login",
          help: "your GitHub login on your boxes · $ABE_OWNER wins · gh's when empty",
        }),
      ],
    },
    {
      caption: 'Stores',
      rows: [
        set('stores.logs', 'Session logs', 'text', {
          help: 'file://<dir> or s3://<bucket> · $ABE_LOG_STORE wins',
        }),
        set('stores.org', 'Prototypes and Sheets', 'text', {
          help: 'the store they are kept in · file://<dir> or s3://<bucket> · $ABE_ORG_STORE wins',
        }),
      ],
    },
  ],
  'browser-profiles': [
    {
      caption: null,
      rows: [
        set('browser.profiles', 'Profiles', 'table', {
          help: "the repo's shared ones and your own; a verify step names one",
        }),
        set('browser.default', 'Default profile', 'combo', {
          known: 'browser-profiles',
          none: 'a fresh profile',
          help: 'unset: a fresh profile every start',
        }),
      ],
    },
  ],
  'factory-policy': [
    {
      caption: 'Merge',
      rows: [
        set('autoMerge', 'Auto merge', 'checkbox'),
        set('factory.done', 'Done when', 'combo', {
          choices: ['merged'],
          known: 'environments',
          free: true,
          help: 'deployed to this environment, or merged',
        }),
      ],
    },
    {
      caption: 'Checks',
      rows: [
        set('checks', 'Checks', 'chips', {
          help: "each one's command is its run: in the repo's abe.yaml",
        }),
        set('testFiles', 'Test files', 'chips'),
        set('checksEnv', 'Checks environment', 'combo', {
          choices: ['dev', 'test', 'prod'],
          none: 'dev',
          help: 'its Abe env file and aws keys: off for agents, the checks are refused',
        }),
        set('setup', 'Worktree setup', 'text'),
        set('worktree', 'Worktree recipe', 'records', {
          help: "what a new worktree gets from the main checkout; a group's only while its environment is on",
        }),
        set('pr.pushTimeout', 'Push timeout', 'number', {
          unit: 'min',
          help: "the repo's pre-push hook runs inside the push",
        }),
      ],
    },
    {
      caption: 'Hook points',
      rows: [
        field('hooks', 'start', 'Start script', 'text', {
          size: 'path',
          help: "each role Abe calls, in the repo's abe.yaml: unset, today's place",
        }),
        field('hooks', 'stop', 'Stop script', 'text', { size: 'path' }),
        field('hooks', 'seed', 'Seed script', 'text', { size: 'path' }),
        field('hooks', 'db', 'Database script', 'text', { size: 'path' }),
        field('hooks', 'query', 'Query script', 'text', { size: 'path' }),
        field('hooks', 'prototype-start', 'Prototype start', 'text', { size: 'path' }),
        field('hooks', 'prototype-stop', 'Prototype stop', 'text', { size: 'path' }),
        field('hooks', 'worktree-setup', 'Worktree script', 'text', {
          size: 'path',
          help: 'serve runs it last in each new worktree',
        }),
        field('hooks', 'run-app', 'Run-app skill', 'text', { size: 'short' }),
        field('hooks', 'testing', 'Testing skill', 'text', { size: 'short' }),
        field('hooks', 'verify', 'Verification skill', 'text', { size: 'short' }),
        field('hooks', 'find-out', 'Find-out heading', 'text', { help: 'in CLAUDE.md' }),
        field('hooks', 'read-data', 'Read-data heading', 'text', { help: "in run-app's SKILL.md" }),
      ],
    },
    {
      caption: 'The app',
      rows: [
        set('kind', 'Repo kind', 'records', {
          help: "unset: Read's; a monorepo's per part (its folder)",
        }),
        set('ports.fixed', 'Fixed ports', 'chips', { help: "one session's app at a time" }),
        set('gate.testHosts', 'Test hosts', 'chips', { help: 'the gate lets them through' }),
        set('gate.readOnlyHosts', 'Read-only prod hosts', 'chips', {
          help: 'prod the app only reads from',
        }),
        set('env.notUsed', 'Not used by the app', 'records', {
          help: 'keys and env files the gate does not judge',
        }),
      ],
    },
  ],
  // Local mode (#24, LM-Setting): this checkout's checkbox (`abe local status`, on and off with
  // `abe local on|off`), what it means as fixed lines, then every checkout your Layer lists
  'local-mode': [
    {
      caption: null,
      rows: [
        {
          ...table(
            'local.here',
            'Local mode',
            'Read the board, issues, PRs and CI; hold every write on this machine. For trying the Factory on a real repo.',
          ),
          control: 'checkbox',
        },
        localLine(
          'local.reads',
          'Reads',
          'as usual: the board (GitHub Projects or Azure Boards), issues, pull requests, CI runs, deploys',
        ),
        localLine(
          'local.writes',
          'Writes, held',
          'card moves, assignments, comments, spec issues, pushes, pull requests, merges: listed under Held writes, each openable',
        ),
        localLine(
          'local.agents',
          'Agents',
          'run on this machine (Local sandbox); no boxes, no cloud runs. Your logins are only read',
        ),
        localLine(
          'local.off',
          'Turning it off',
          'from the next write on, writes go out. Held ones stay a record; nothing is ever sent',
        ),
        localLine(
          'local.done',
          'Done',
          'a card is Done when its local pull request merges (there is no deploy to watch)',
        ),
        set('localMode', 'Local mode checkouts', 'chips', {
          size: 'path',
          help: 'these checkouts read the board and GitHub; every write waits on this machine',
        }),
        set('boardReadOnly', 'Read-only board checkouts', 'chips', {
          size: 'path',
          help: 'the board only: its changes stay on this machine, drawn over its cards · abe board read-only on|off',
        }),
      ],
    },
  ],
  reach: [
    {
      caption: 'Reaches',
      rows: [
        set('reach', 'Reaches', 'chips', {
          help: 'write credentials an agent may get',
        }),
        set('environments', 'Environments', 'records', {
          help: "the repo's: each environment's AWS account, write policy and databases",
        }),
        table('reach.live', 'Live overrides', 'each with who gave it and why'),
        table(
          'reach.layers',
          'Where reaches come from',
          'a layer lowers a default only by an override with its reason',
        ),
      ],
    },
    {
      caption: 'Reads',
      rows: [
        {
          id: 'reach.reads',
          label: 'Agents read',
          control: 'text',
          fixed: {
            by: 'built-in',
            value: 'only the environments on for them',
            why: 'off: not reached at all, reads included · Agents & models › Environments',
          },
        },
      ],
    },
  ],
  // out of the tree until it lists each Layer's file (#345: no empty page); a Layer file's
  // problems are on Problems, its file one ⏎ away
  layers: [],
  'logins-tools': [
    {
      caption: 'Logins',
      rows: [
        table('logins', 'Logins', 'this machine · checked when Settings opens'),
        set('logins', 'This repo needs', 'chips', {
          id: 'logins.needs',
          help: "logins: in the repo's abe.yaml · abe login status --repo checks them",
        }),
        set('sources', 'This repo reads', 'chips', {
          help: "sources: in the repo's abe.yaml · abe install source adds them",
        }),
      ],
    },
    {
      caption: 'Tools',
      rows: [table('tools', 'Tools', "as abe serve runs them, on serve's PATH")],
    },
  ],
  // out of the tree until it lists the skills loaded per Layer (#345: no empty page)
  skills: [],
  'version-control': [],
  tools: [
    {
      caption: 'Commands',
      rows: [
        set('serve.target', 'Commands run', 'segmented', {
          choices: SERVE_TARGETS,
          words: { cloud: 'a cloud box', local: 'this machine' } satisfies Record<
            (typeof SERVE_TARGETS)[number],
            string
          >,
          help: 'this machine until you set up boxes; a cloud box: one of your own per card',
        }),
      ],
    },
    {
      caption: 'Improve',
      rows: [
        set('improve.suggest', 'Suggest by itself', 'checkbox', { help: 'at most once a day' }),
        set('improve.issueRepo', 'VimStorm issues go to', 'text'),
      ],
    },
    {
      caption: 'Pipelines',
      rows: [
        set('pipelines', 'Runs come from', 'segmented', {
          choices: PIPELINE_PROVIDERS,
          words: PROVIDER_TITLE,
          help: "Azure Pipelines: the board's organization and project",
        }),
        set('prodEnvironments', 'Also prod', 'chips', {
          help: 'besides prod, production, prd and live: approving a deploy to one asks a yes',
        }),
      ],
    },
  ],
};

const leaf = (id: PageId, label: string, children: readonly TreeNode[] = []): TreeNode => ({
  id,
  label,
  page: id,
  children,
});

const group = (id: string, label: string, children: readonly TreeNode[]): TreeNode => ({
  id,
  label,
  page: null,
  children,
});

/** Every page the catalogue knows, Behaviour 2's order. */
const ALL_PAGES: readonly TreeNode[] = [
  { ...leaf('problems', 'Problems'), whileProblems: true },
  group('appearance-behavior', 'Appearance & Behavior', [
    leaf('appearance', 'Appearance'),
    leaf('import-config', 'Import config'),
  ]),
  leaf('keymap', 'Keymap'),
  group('editor', 'Editor', [
    leaf('editor-general', 'General'),
    leaf('editor-font', 'Font'),
    leaf('color-scheme', 'Color scheme'),
    leaf('vim', 'Vim'),
  ]),
  group('abe', 'Abe', [
    leaf('agents', 'Agents & models'),
    leaf('board-team', 'Board & you'),
    leaf('boxes-cloud', 'Boxes & cloud', [leaf('browser-profiles', 'Browser profiles')]),
    leaf('factory-policy', 'Factory policy'),
    leaf('local-mode', 'Local mode'),
    leaf('reach', 'Reach'),
    leaf('layers', 'Layers'),
  ]),
  leaf('logins-tools', 'Logins & tools'),
  leaf('skills', 'Skills'),
  leaf('version-control', 'Version control'),
  leaf('tools', 'Tools check'),
];

/** The pages whose lines are their own, not rows of the catalogue: shown with no rows. */
const OWN_LINES: ReadonlySet<PageId> = new Set(['problems', 'import-config']);

/** A page with nothing in it leaves the tree until it has (#345: Version control, Skills). */
const withRows = (nodes: readonly TreeNode[]): TreeNode[] =>
  nodes.flatMap((n) => {
    const children = withRows(n.children);
    const own = n.page !== null && (GROUPS[n.page].length > 0 || OWN_LINES.has(n.page));

    if (!own && children.length === 0) return [];

    return [{ ...n, children }];
  });

/** The tree, Behaviour 2's order: a page with nothing to set is left out. */
export const SETTINGS_TREE: readonly TreeNode[] = withRows(ALL_PAGES);

/** Each page's node with its path from the top, in tree order. */
const walk = (
  nodes: readonly TreeNode[],
  path: readonly string[] = [],
): { node: TreeNode; path: string[] }[] =>
  nodes.flatMap((node) => [
    { node, path: [...path, node.label] },
    ...walk(node.children, [...path, node.label]),
  ]);

const rowOfSpec = (page: PageId, caption: string | null, spec: RowSpec): SettingRow => {
  const id =
    spec.id ??
    (spec.key === undefined
      ? spec.label
      : `${spec.key}${spec.field === undefined ? '' : `#${spec.field}`}`);

  return {
    id,
    page,
    group: caption,
    label: spec.label,
    control: spec.control,
    help: spec.help ?? '',
    key: spec.key ?? null,
    field: spec.field ?? null,
    choices: spec.choices ?? null,
    known: spec.known ?? null,
    free: spec.free === true,
    clearable: spec.key !== undefined && takesNone(spec.key, spec.field ?? null),
    words: spec.words ?? null,
    none: spec.none ?? null,
    unit: spec.unit ?? null,
    size: spec.size ?? 'free',
    personalOnly: spec.key !== undefined && (isMineSetting(spec.key) || isMachineSetting(spec.key)),
    fixed: spec.fixed ?? null,
    link: spec.link ?? null,
  };
};

const emptyText = (id: PageId) => (id === 'problems' ? 'No problems' : NOTHING_TO_SET);

/** Every page in tree order, with its rows. */
export const PAGES: readonly SettingsPage[] = walk(SETTINGS_TREE).flatMap(({ node, path }) => {
  const id = node.page;

  if (id === null) return [];
  const rows = GROUPS[id].flatMap((g) => g.rows.map((r) => rowOfSpec(id, g.caption, r)));

  return [
    {
      id,
      label: node.label,
      crumb: path.join(' › '),
      rows,
      empty: rows.length > 0 ? null : emptyText(id),
    },
  ];
});

for (const row of PAGES.flatMap((p) => p.rows))
  if (
    row.link !== null &&
    !PAGES.some((p) => p.id === row.link?.page && p.rows.some((r) => r.id === row.link?.row))
  )
    throw new Error(`${row.id} links to no home row`);

const BY_ID = new Map(PAGES.map((p) => [p.id, p]));

export const pageOf = (id: PageId): SettingsPage => {
  const page = BY_ID.get(id);

  if (page === undefined) throw new Error(`no settings page ${id}`);

  return page;
};

export const isPageId = (id: string): id is PageId => PAGE_IDS.some((p) => p === id);

/** Every row once: link rows left out. What `settings list` lists and search matches. */
export const homeRows = (): SettingRow[] =>
  PAGES.flatMap((p) => p.rows.filter((r) => r.link === null));

const ROWS = new Map(PAGES.flatMap((p) => p.rows.map((r) => [r.id, r])));

export const rowOf = (id: string): SettingRow | undefined => ROWS.get(id);

/** A setting's rows (an object setting's one per field), in tree order. */
export const rowsOfKey = (key: SettingKey): SettingRow[] =>
  PAGES.flatMap((p) => p.rows.filter((r) => r.key === key));

/** A setting's home row (its first one; an object setting's first field). */
export const homeRowOf = (key: SettingKey): SettingRow | undefined => rowsOfKey(key)[0];

/** The page a tree node opens: its own, else its first child's. */
export const openPage = (nodeId: string): PageId | undefined => {
  const node = walk(SETTINGS_TREE).find((w) => w.node.id === nodeId)?.node;

  if (node === undefined) return undefined;
  if (node.page !== null) return node.page;
  const [first] = node.children;

  return first === undefined ? undefined : openPage(first.id);
};
