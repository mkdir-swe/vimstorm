/**
 * Every setting Abe knows: its value's schema, core's default (the core Layer, shipped in the
 * binary), how a lower Layer's entry adds to the value above, and which changes need an Override.
 */
import { z } from 'zod';
import { MAX_IDLE_MINUTES } from '../../box/box-idle';
import { SUBAGENTS_DEFAULT } from '../../skills/instructions';
import { BOX_SIZES, boxSizeRank } from '../../box/box-sizes';
import { DONE_ENVIRONMENT } from '../../factory/factory-pr';
import { addProfiles, BrowserProfile, ProfileName } from '../../browser/browser-profiles';
import { boardProviderOf, noCardsProviderOf, providerRefusal } from '../../board/board-provider';
import { addChecks, CheckEntryValue, loweredChecks } from './checks';
import { Environments, isWriteName, parseReachName } from './reach';
import { viewProblems, ViewTweaks } from '../../improve/views';
import { isProd, PIPELINE_PROVIDERS } from '../../board/pipelines';
import { addLogins, LoginEntryValue } from '../../logins/logins';
import { AbeEnv, Credentials } from '../../install/credentials';
import { RepoKindSaid } from '../../install/install-kind';
import { addSources, SourceEntries } from '../../install/source-servers';
import { REPO_PATH } from './places';
import { WorktreeRecipe } from '../../session/worktree-recipe';
import { DeclaredHooks } from '../../repo-hooks';

/**
 * The Layers, top first: each adds to the ones above (ADR 0030). `feel` is no file: your Feel's
 * bundle (#121), the step a key takes from core's default where the Feel gives another (#174).
 * `individual` is yours.
 */
export const LAYERS = ['core', 'feel', 'repo', 'individual'] as const;
export type Layer = (typeof LAYERS)[number];

/** The Layers a person writes; core ships in the binary. */
export const WRITABLE_LAYERS = ['repo', 'individual'] as const;
export type WritableLayer = (typeof WRITABLE_LAYERS)[number];

/**
 * The files settings are read from, in the order applied (ADR 0030): the repo's
 * (`abe.yaml`), yours on this Mac (`~/.config/abe/settings.yaml`: editor preferences
 * and your environment), yours for this repo (`.abe/settings.local.yaml`, never tracked).
 */
export const PLACES = ['repo', 'machine', 'local'] as const;
export type Place = (typeof PLACES)[number];

/** The Layer a file is: the repo's, or yours (on this Mac or for this repo). */
export const layerOfPlace = (place: Place): WritableLayer =>
  place === 'repo' ? 'repo' : 'individual';

/** A factory or agent setting: the repo's file, yours for this repo over it. */
const FACTORY = ['repo', 'local'] as const satisfies readonly Place[];
/** Yours for this repo alone: never the repo's file. */
const MINE = ['local'] as const satisfies readonly Place[];
/** The team's (ADR 0031): the repo's file alone, never yours. */
const TEAM = ['repo'] as const satisfies readonly Place[];
/** An editor preference or your environment: yours, on this Mac. */
const MACHINE = ['machine'] as const satisfies readonly Place[];
/**
 * The repo's to decide, yours for this repo over it, yours on this Mac only where neither says
 * (`serve.target`, 3.2.2): applied in this order, so the Mac's comes first.
 */
const REPO_OVER_MACHINE = ['machine', 'repo', 'local'] as const satisfies readonly Place[];

const names = z.array(z.string().min(1));

/**
 * A GitHub login: letters, digits and single hyphens, never a hyphen at either end, at most 39
 * characters; an enterprise managed user's adds `_<shortcode>` (up to 20 characters).
 */
export const GITHUB_LOGIN =
  /^(?=[^_]{1,39}(?:_|$))[A-Za-z0-9](?:-?[A-Za-z0-9])*(?:_[A-Za-z0-9]{1,20})?$/;
const GithubLogin = z
  .string()
  .regex(
    GITHUB_LOGIN,
    'a GitHub login (at most 39 characters; a managed user adds _ and a shortcode of up to 20), without URL or credential',
  );

/** The window's density (#108): Compact is today's metrics, Default WebStorm's default density. */
export const DENSITIES = ['compact', 'default'] as const;

/**
 * Feel profiles (#121, #214): the bundles of behaviour switches `ui.feel` picks from (`feel.ts`):
 * `vim` is stock Vim's keys with your own `~/.config/nvim` on top.
 */
export const FEELS = ['vimstorm', 'webstorm', 'vscode', 'vim'] as const;
export type Feel = (typeof FEELS)[number];

/** Each Feel by its name (#325). */
export const FEEL_WORDS = {
  vimstorm: 'VimStorm',
  webstorm: 'WebStorm',
  vscode: 'VS Code',
  vim: 'Vim',
} as const satisfies Record<Feel, string>;

/** What the Project tree marks a changed file with: git colours, or colours and M / U / D letters. */
export const TREE_DECORATIONS = ['colors', 'letters'] as const;

/** When an edited file is written (VS Code's names): never by itself, on focus loss, after a pause. */
export const AUTO_SAVES = ['off', 'onFocusChange', 'afterDelay'] as const;

/**
 * Where commands run (`serve.target`): your environment or this Mac. A value Abe does not know is
 * read as `local` (#166): a typo never sends work to AWS.
 */
export const SERVE_TARGETS = ['cloud', 'local'] as const;

/**
 * The MCP servers a local chat loads (`session.mcp`): yours (your ~/.claude.json servers, your
 * claude.ai connectors) beside Abe's, or Abe's own alone. A card's session, an install's and a
 * box's always load Abe's own and the repo's `sources:` alone, each from your own config
 * (`--strict-mcp-config`). A repo's own servers (its `.mcp.json`) never load: a chat of yours
 * rejects them in its settings.
 */
export const SESSION_MCPS = ['yours', 'abe-only'] as const;
export const SessionMcp = z.enum(SESSION_MCPS);
export type SessionMcp = z.infer<typeof SessionMcp>;

/** Claude Code's effort for a new session (#108). */
export const EFFORTS = ['low', 'medium', 'high'] as const;

/** A font size in px, as the font combos offer them. */
const fontSize = z.number().int().min(9).max(24);
const fontFamily = z.string().trim().min(1);
/** Where a store is: a folder (`file://<dir>`) or a bucket (`s3://<bucket>[/<prefix>]`). */
const StoreUrl = z
  .string()
  .regex(/^(file:\/\/\/|s3:\/\/[a-z0-9])/, 'file://<dir> or s3://<bucket>[/<prefix>]');
const model = z.string().regex(/^[\w.-]+$/, 'a model name, as allowedModels names it');

/** Where a spec goes: GitHub issues, the board's cards, or files in the repo. */
export const SPEC_PLACES = ['issue', 'card', 'file'] as const;

/** The value schemas, one per key: the shape of the merged settings. */
const SHAPE = {
  'serve.target': z.enum(SERVE_TARGETS),
  allowedModels: names.min(1),
  autoMerge: z.boolean(),
  // An environment's name, as the deployments to it are named on GitHub, or `merged`.
  'factory.done': z.string().regex(/^[\w.-]+$/, 'an environment name, or merged'),
  checks: z.array(CheckEntryValue),
  testFiles: names,
  // The team's MCP servers (ADR 0031): what a repo's sessions read besides the board and GitHub.
  sources: SourceEntries,
  setup: z.string().trim().min(1).nullable(),
  // The team's recipe for a new worktree (abe.yaml): what it gets from the main checkout.
  worktree: WorktreeRecipe,
  // The team's hook points (abe.yaml, ADR 0035): each role's script, skill or heading.
  hooks: DeclaredHooks,
  // The repo's kind as the person said it (abe.yaml, ADR 0040): one, or a monorepo's per part.
  kind: RepoKindSaid.nullable(),
  // The environment the checks run with (abe.yaml, ADR 0040): judged from the repo's evidence.
  checksEnv: AbeEnv.nullable(),
  // The keys and env files the app never uses, with how the person knows (abe.yaml, ADR 0040).
  'env.notUsed': z.array(
    z.strictObject({ key: z.string().trim().min(1), why: z.string().trim().min(1) }),
  ),
  // Where the spec stage's spec and slices go, chosen at Factory install (Board).
  'spec.where': z.enum(SPEC_PLACES),
  // Yours for this repo (ADR 0027, 0030): each environment's aws profile and env file, names only.
  credentials: Credentials,
  // Yours for this repo (ADR 0027, 0030): the person's yes to writes to TEST, from Verify alone.
  testWrites: z.boolean(),
  // Yours for this repo (ADR 0029, 0030): each environment on or off for agents.
  'agents.dev': z.boolean(),
  'agents.test': z.boolean(),
  'agents.prod': z.boolean(),
  logins: z.array(LoginEntryValue),
  reach: z.array(z.string().regex(/^ABE_[A-Z0-9]+(_[A-Z0-9]+)*$/, 'an ABE_* name')),
  environments: Environments,
  // The Board's keys typed (`boardOf` checks them further); other readers' keys (columns) pass.
  board: z
    .object({
      // `azure`, `local` or `github` (azure-boards, azure-devops and ado read as azure, github-issues and gh as github); github-projects and jira are known, with no cards yet
      provider: z
        .string()
        .min(1)
        .refine((v) => boardProviderOf(v) !== undefined || noCardsProviderOf(v) !== undefined, {
          error: (issue) => providerRefusal(issue.input),
        })
        .optional(),
      organization: z.string().min(1).optional(),
      project: z.string().min(1).optional(),
      team: z.string().min(1).optional(),
      types: names.min(1).optional(),
      /** The state a Factory run's card moves to when it starts building (`Active`). */
      active: z.string().min(1).optional(),
      /** The state it moves to at Done (`Closed`). */
      done: z.string().min(1).optional(),
      /** The state it goes back to when a person abandons its run (`New`, #184). */
      new: z.string().min(1).optional(),
      /**
       * Which cards of a shared board are this repo's: an area path (the cards under it) and a
       * tag (the cards carrying it). Card lists and Factory runs in the repo read only those.
       */
      area: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
      tag: z.string().min(1).optional(),
      /**
       * The cards a repo leaves out of every list: those in these swimlanes (`System.BoardLane`,
       * a card in the default lane stays) and those carrying this tag (an issue's label too).
       */
      excludeLanes: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
      notTag: z.string().min(1).optional(),
      /** A GitHub board's repo, `<owner>/<name>`: unset, the checkout's origin. */
      repo: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/, 'a GitHub repo, like acme/shop')
        .optional(),
      /** Your az's login folder (`$AZURE_CONFIG_DIR`, #344): yours, never the repo's. */
      azureConfigDir: z.string().min(1).optional(),
    })
    .catchall(z.json()),
  // Where the Pipelines tab reads the repo's runs: GitHub Actions, or Azure Pipelines in
  // the `board` setting's organization and project.
  pipelines: z.enum(PIPELINE_PROVIDERS),
  prodEnvironments: names,
  // A GitHub login (1.x's rule): letters, digits and single dashes, no URL or credential.
  githubIdentity: GithubLogin.nullable(),
  // Yours for this repo (ADR 0031): your account per tool, names only, as `logins: { gh, az }`.
  // `logins.gh` is the gh login Abe reads and writes GitHub as (its token from gh's keyring, never
  // switched).
  'logins.gh': GithubLogin.nullable(),
  'logins.az': z
    .string()
    .trim()
    .min(1)
    .regex(/^[^\s/]+$/, 'an az account name, like you@example.com, without URL or credential')
    .nullable(),
  'limits.maxBoxesPerPerson': z.number().int().positive(),
  'limits.maxBoxSize': z.enum(BOX_SIZES),
  // A box's root disk grows by itself up to this (ADR 0022, #344), in GB.
  'limits.maxBoxDisk': z.number().int().min(40).max(4096),
  // A new repo box's size (#344): within limits.maxBoxSize.
  'box.size': z.enum(BOX_SIZES),
  'box.idleMinutes': z.number().int().positive().max(MAX_IDLE_MINUTES),
  'box.waitingMinutes': z.number().int().positive().max(MAX_IDLE_MINUTES),
  // Your environment from a Layer, not the shell (#344, #100): env only overrides each.
  'box.profile': z
    .string()
    .regex(/^[\w.+@-]+$/, 'an AWS profile name, like abe-tooling')
    .nullable(),
  'box.region': z
    .string()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d+$/, 'an AWS region, like eu-west-1')
    .nullable(),
  'box.owner': z
    .string()
    .regex(/^[A-Za-z0-9](?:[\w-]{0,59})$/, 'a GitHub login')
    .nullable(),
  'stores.logs': StoreUrl.nullable(),
  'stores.org': StoreUrl.nullable(),
  'browser.profiles': z.array(BrowserProfile),
  'browser.default': ProfileName.nullable(),
  skillsOnTop: z.boolean(),
  'session.mcp': SessionMcp,
  'move.leave': names,
  'improve.suggest': z.boolean(),
  'improve.issueRepo': z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'an <owner/repo> on GitHub'),
  // The gate's answers for every run of the repo (beside the install's on this Mac).
  'gate.testHosts': z.array(z.string().trim().toLowerCase().min(1)),
  'gate.readOnlyHosts': z.array(z.string().trim().toLowerCase().min(1)),
  // Ports the repo's app always takes (an auth redirect registered for one): one app at a time.
  'ports.fixed': z.array(z.number().int().min(1).max(65535)),
  // Minutes `abe factory pr`'s git push may take: the repo's pre-push hook runs inside it.
  'pr.pushTimeout': z.number().int().min(1).max(240),
  // Local mode (#24): the checkouts (top folders) where Abe reads but holds every write here.
  localMode: z.array(z.string().regex(/^\//, 'a checkout folder, from /')),
  boardReadOnly: z.array(z.string().regex(/^\//, 'a checkout folder, from /')),
  // A prototype session's own model and effort (#350): fast, held to allowedModels at its launch.
  'prototype.model': model,
  'prototype.effort': z.enum(EFFORTS),
  views: ViewTweaks,
  // The look (#108): VimStorm's own settings, layered like the rest.
  'ui.theme': z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a theme slug, like islands-dark'),
  // The editor's colours (#345): `theme`, the theme's own, or a theme named for the editor alone.
  'editor.scheme': z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'theme, or a theme slug like islands-dark'),
  'ui.density': z.enum(DENSITIES),
  'ui.font.family': fontFamily,
  'ui.font.size': fontSize,
  'ui.font.editorFamily': fontFamily,
  'ui.font.editorSize': fontSize,
  'ui.font.ligatures': z.boolean(),
  // Feel profiles (#121): the pick, and the behaviour switches it sets where no Layer does.
  'ui.feel': z.enum(FEELS),
  'tree.autoReveal': z.boolean(),
  'tree.singleClick': z.boolean(),
  'tree.decorations': z.enum(TREE_DECORATIONS),
  'tree.compactFolders': z.boolean(),
  'tabs.limit': z.number().int().min(1).max(100).nullable(),
  'tabs.dirtyDot': z.boolean(),
  'tabs.preview': z.boolean(),
  'files.autoSave': z.enum(AUTO_SAVES),
  'editor.minimap': z.boolean(),
  'editor.vim': z.boolean(),
  'chat.openByDefault': z.boolean(),
  'chat.width': z.number().int().min(320).max(640),
  // Agents (#108): each role's model, held to allowedModels where a session launches.
  'models.coordinator': model,
  'models.reader': model,
  'models.writer': model,
  effort: z.enum(EFFORTS),
  'subagents.max': z.number().int().min(1).max(16),
  // Standing notes (#347): Launch notes every launch gets, each Layer adding to the ones above.
  'launch.notes': z.array(z.string().trim().min(1).max(2000)),
};

export type SettingKey = keyof typeof SHAPE;

/** The merged settings: what every later reader takes its values from. */
export const SettingsSchema = z.strictObject(SHAPE);
export type Settings = z.output<typeof SettingsSchema>;

export type SettingDef<T> = {
  readonly summary: string;
  readonly schema: z.ZodType<T>;
  readonly default: T;
  /** A plain entry: what the value becomes below `above`. */
  add(above: T, written: T): T;
  /** An Override entry (default: its value replaces the one above). */
  lower?(above: T, written: T): T;
  /**
   * Changes a plain entry may not make: from `from` down, `needs` says why an Override is needed
   * to go from `above` to `next`, or `undefined` when none is.
   */
  readonly guard?: { from: Layer; needs(above: T, next: T, written: T): string | undefined };
  /**
   * Overrides a Layer may not write even with a reason: why, or `undefined` when it may. Only
   * Reach's write names (credentials, ADR 0010); every other setting takes an Override from any
   * Layer, yours too (#168).
   */
  overrideGuard?(layer: Layer, written: T): string | undefined;
  /**
   * A value no Layer gives, plain or by Override, whatever its reason: why (ADR 0029: `reach`'s
   * write names for a prod environment). Refused as `prod-off`.
   */
  never?(written: T): string | undefined;
  /**
   * The files it is read from (ADR 0030), in the order applied (the last one's wins); none: a
   * factory setting, the repo's file and yours for this repo. An entry in another file is a
   * problem, except a factory one in yours on this Mac: it is not read.
   */
  readonly places?: readonly Place[];
  /** Why an entry in a file the setting is not read from is refused (yours alone, or the team's), said in its problem. */
  readonly onlyWhy?: string;
  /**
   * What an entry the schema refuses is read as, and why (`serve.target`: `local`, never cloud);
   * without one, the entry is dropped and the value above stays.
   */
  readonly safe?: { value: T; why: string };
  /** What a valid value still may not be (a view tweak's unknown node): the entry is dropped. */
  check?(written: T): { code: 'unknown-node' | 'invalid-setting'; message: string } | undefined;
};

/** The provider a merged `board` value names; Azure when it names an organization or project. */
const providerBelow = (board: Settings['board']) => {
  if (board.provider !== undefined) return boardProviderOf(board.provider);

  return board.organization !== undefined || board.project !== undefined ? 'azure' : undefined;
};

const replace = <T>(_: T, written: T): T => written;
const union = (above: string[], written: string[]): string[] => [
  ...new Set([...above, ...written]),
];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Yours, any change: the repo's value is the one in force (ADR 0010, 0030). */
const changes = {
  from: 'individual',
  needs: (above: unknown, next: unknown) =>
    same(above, next) ? undefined : 'changes the value above',
} as const;

/**
 * An environment on or off for agents in a repo (ADR 0029): yours alone, for this repo; on, its
 * sessions reach it in full, off not at all. The repo's file never turns one on, an Override neither.
 */
const agentEnv = (env: string, on: boolean): SettingDef<boolean> => ({
  summary: `whether this repo's agents reach ${env}, read and write (${on ? 'on' : 'off'} by default); off, its Abe env file, aws profile and hosts are out of every session; a change applies to the next session; yours alone, for this repo`,
  schema: z.boolean(),
  default: on,
  add: replace,
  places: MINE,
  onlyWhy: `only you turn ${env} on or off for this repo's agents, in .abe/settings.local.yaml (abe settings set agents.${env} <true|false> --mine): the repo's settings.yaml never does, an Override there neither (ADR 0029)`,
});

export const SETTINGS: { readonly [K in SettingKey]: SettingDef<Settings[K]> } = {
  'serve.target': {
    summary:
      "where commands run: local (this Mac; the default) or cloud (your own box per repo, a workspace per card on it, once you set up boxes); the repo's abe.yaml decides, yours for the repo over it, yours on this Mac where neither says (ADR 0042)",
    schema: SHAPE['serve.target'],
    default: 'local',
    add: replace,
    safe: { value: 'local', why: 'a target Abe does not know never means cloud' },
    places: REPO_OVER_MACHINE,
  },
  allowedModels: {
    summary: 'the models agents may use; each agent falls to the first allowed one',
    schema: SHAPE.allowedModels,
    default: ['opus', 'sonnet', 'haiku'],
    add: replace,
    guard: changes,
  },
  autoMerge: {
    summary: 'merge a green pull request without a person (opt-in by Override)',
    schema: SHAPE.autoMerge,
    default: false,
    add: replace,
    guard: changes,
  },
  'factory.done': {
    summary:
      'when a Factory run is Done: the environment whose deploy of the merge commit is Done (test), or merged for a repo with no deploy to wait for',
    schema: SHAPE['factory.done'],
    default: DONE_ENVIRONMENT,
    add: replace,
  },
  checks: {
    summary:
      'the deterministic checks run after build: names, or { name, run } with the command; a lower Layer adds to them',
    schema: SHAPE.checks,
    default: ['tests', 'types', 'lint', 'no-deleted-tests', 'no-new-suppressions'],
    add: addChecks,
    // Yours dropping a check or changing its command takes an Override.
    guard: { from: 'individual', needs: (above, next) => loweredChecks(above, next) },
  },
  testFiles: {
    summary:
      'what a test file is, for no-deleted-tests: a name glob (*.test.*), a folder (tests/) or a path from the root',
    schema: SHAPE.testFiles,
    default: ['*.test.*', '*.spec.*', 'test/', 'tests/'],
    // Plain entries only add patterns: fewer test files is an Override.
    add: union,
  },
  sources: {
    summary:
      "the team's MCP servers the repo's sessions read besides the board and GitHub, each { name, transport: http|sse|stdio, url, or command and args }: no secret (a header or env is a ${VAR} reference), you sign in once and Claude Code keeps the token; the repo's file alone (abe.yaml), written by abe install source",
    schema: SHAPE.sources,
    default: [],
    add: addSources,
    places: TEAM,
    onlyWhy: `sources are the team's: set them in the repo's ${REPO_PATH} (abe install source <name|url>), never in yours`,
  },
  credentials: {
    summary:
      "each environment's aws profile and env file for this repo's app and checks (names and paths only, never a value), yours for this repo, set by the Factory install; sessions see only key names",
    schema: SHAPE.credentials,
    default: {},
    add: replace,
    places: MINE,
  },
  testWrites: {
    summary:
      "your yes to writes to this repo's TEST backends, only ever from the Factory's Verify stage; yours for this repo",
    schema: SHAPE.testWrites,
    default: false,
    add: replace,
    places: MINE,
  },
  'agents.dev': agentEnv('dev', true),
  'agents.test': agentEnv('test', true),
  'agents.prod': agentEnv('prod', false),
  'spec.where': {
    summary:
      "where a spec and its slices go: issue (GitHub issues under the card's repo), card (comments on the card), or file (.abe/specs/<card>/ in the repo); chosen at Factory install",
    schema: SHAPE['spec.where'],
    default: 'issue',
    add: replace,
  },
  setup: {
    summary:
      "the command run in a card's new worktree before its claude starts (the repo pack's npm ci); its failure is Needs you with the output",
    schema: SHAPE.setup,
    default: null,
    add: replace,
  },
  worktree: {
    summary:
      "the repo's recipe for a new worktree (a card's, its Before worktree, a prototype's, a box workspace's): link, the untracked files and folders linked from the main checkout (env files the app and tests read); copy, those copied, the worktree's own to change. Each a list, or grouped per environment (ADR 0040): all, every run; dev, test, prod, only while that environment is on for agents (a prod group never turns prod on). A group places its env files; a flat list's are placed by the install's env map. An env file placed only in environments off for agents is left out. Its script is hooks.worktree-setup. The team's file alone (abe.yaml)",
    schema: SHAPE.worktree,
    default: {},
    add: replace,
    places: TEAM,
    onlyWhy: `the worktree recipe is the team's: set it in the repo's ${REPO_PATH}, never in yours`,
  },
  kind: {
    summary:
      "the repo's kind when Read reads it wrong (ADR 0026, 0040): web-app, service, config, iac, library, cli, or a monorepo's per part (its folder: its kind); unset, Read's from the files. Run locally, Verify and Checks follow it. The team's file alone (abe.yaml), written by abe install kind",
    schema: SHAPE.kind,
    default: null,
    add: replace,
    places: TEAM,
    onlyWhy: `the repo's kind is the team's: set it in the repo's ${REPO_PATH}, never in yours`,
  },
  checksEnv: {
    summary:
      "the environment the checks run with (its Abe env file and aws profile's keys; dev when unset), judged from the repo's scripts, CI and README by the install (abe install checks-env); one off for agents refuses the checks, it never turns one on (ADR 0029)",
    schema: SHAPE.checksEnv,
    default: null,
    add: replace,
  },
  'env.notUsed': {
    summary:
      'the keys and env files the app never uses, each { key, why }: how you know; the gate does not judge them, and an env file named here is placed nowhere. Written by abe install env-map (not-used) and abe install gate --not-used; names only, never a value',
    schema: SHAPE['env.notUsed'],
    default: [],
    add: (above, written) => [
      ...above.filter((a) => !written.some((w) => w.key === a.key)),
      ...written,
    ],
  },
  hooks: {
    summary:
      "the repo's hook points, each a role Abe calls (ADR 0035): the app's scripts start, stop, seed, db and query (in the run-app skill's scripts/ unless said), prototype-start and prototype-stop (abe/scripts/), worktree-setup (none unless said: serve runs it last in a new worktree); the skills run-app, testing (any <name>-testing unless said) and verify (verify-<app> unless said); the headings find-out (CLAUDE.md's ## Find out before you ask) and read-data (run-app's ## Read data). A role left out is today's place. What an agent's abe run may run is read from the committed abe.yaml. The team's file alone (abe.yaml)",
    schema: SHAPE.hooks,
    default: {},
    add: replace,
    places: TEAM,
    onlyWhy: `the hook points are the team's: set them in the repo's ${REPO_PATH}, never in yours`,
  },
  logins: {
    summary:
      "the logins this repo needs (gh, claude, az, aws), each a tool or a tool with options (aws: { profile: <sso profile>, sso: true }, az: { tenant }): checked by abe login status --repo, before a card's run and the install's Board; a missing one is Needs you with its abe login. A lower Layer adds tools or changes a tool's options",
    schema: SHAPE.logins,
    default: [],
    add: addLogins,
    // the team's (ADR 0031): yours for the repo names your accounts instead (logins.gh, logins.az)
    places: TEAM,
  },
  'logins.gh': {
    summary:
      "your gh account for this repo (logins: { gh } in .abe/settings.local.yaml): the gh login Abe reads and writes GitHub as, and its sessions' gh (gh auth token --user, never gh auth switch); unset, gh's active one",
    schema: SHAPE['logins.gh'],
    default: null,
    add: replace,
    places: MINE,
  },
  'logins.az': {
    summary:
      "your az account for this repo (logins: { az } in .abe/settings.local.yaml), a name only; unset, az's signed-in one",
    schema: SHAPE['logins.az'],
    default: null,
    add: replace,
    places: MINE,
  },
  reach: {
    summary: 'the ABE_* reach names granted; a write name only by an Override',
    schema: SHAPE.reach,
    default: [],
    add: union,
    lower: union,
    guard: {
      from: 'repo',
      needs: (above, _, written) => {
        const added = written.filter((name) => isWriteName(name) && !above.includes(name));

        return added.length === 0 ? undefined : `grants the write name ${added.join(', ')}`;
      },
    },
    // A write is the repo's to grant (ADR 0010, 0030): yours never grants one.
    overrideGuard: (layer, written) => {
      const writes = written.filter(isWriteName);

      return layer === 'repo' || writes.length === 0
        ? undefined
        : `grants the write name ${writes.join(', ')}: only the repo's settings.yaml grants a write`;
    },
    // No file reaches prod for agents (ADR 0029), Override or not: only you turn it on.
    never: (written) => {
      const prod = written.filter((name) => {
        const r = parseReachName(name);

        return r?.access === 'write' && isProd(r.environment);
      });

      return prod.length === 0
        ? undefined
        : `grants ${prod.join(', ')}, a write to prod: agents reach prod only when you turn it on for this repo (agents.prod, ADR 0029), never by a Layer`;
    },
  },
  environments: {
    summary: "the repo's environments: each one's AWS account and its database URLs' secrets",
    schema: SHAPE.environments,
    default: {},
    add: replace,
  },
  board: {
    summary:
      "the repo's board: provider (azure, local, or github for the repo's GitHub Issues: repo, <owner>/<name>, else origin's; labels active and resolved for its middle columns); organization (https://dev.azure.com/<org>), project, team, types; area (an area path) and tag, which cards of a shared board are this repo's; excludeLanes (swimlanes) and notTag, the cards it leaves out; active, done and new, the states a Factory run's card moves to (Active, Closed, and New when a person abandons the run); azureConfigDir, your own az login folder ($AZURE_CONFIG_DIR overrides it)",
    schema: SHAPE.board,
    default: {},
    add: (above, written) => {
      const now = written.provider === undefined ? undefined : boardProviderOf(written.provider);

      // a Layer that moves the board to another provider starts it over: yours On this Mac
      // never inherits the repo's Azure organization or team
      return now !== undefined && now !== providerBelow(above) ? written : { ...above, ...written };
    },
  },
  pipelines: {
    summary:
      "where the Pipelines tab reads the repo's runs: github-actions (the repo's GitHub Actions) or azure-pipelines (the board setting's organization and project)",
    schema: SHAPE.pipelines,
    default: 'github-actions',
    add: replace,
  },
  prodEnvironments: {
    summary:
      'environments that are prod besides the ones named prod, production, prd or live: approving a deploy to one always asks a yes; a lower Layer only adds to them',
    schema: SHAPE.prodEnvironments,
    default: [],
    // only ever more: a Layer never makes an environment not prod
    add: union,
    lower: union,
  },
  githubIdentity: {
    summary:
      "the GitHub login the review screen's writes go as (a review, comment, reply, Draft PR, merge): gh signed in as another refuses them; unset, gh's login goes",
    schema: SHAPE.githubIdentity,
    default: null,
    add: replace,
    // whose login it is: the repo's file naming one would refuse everyone else's reviews
    places: MINE,
  },
  'limits.maxBoxesPerPerson': {
    summary:
      "the most boxes one person has running or starting, asleep ones not (a launch or wake past it is Queued); the repo's cap: yours lowers it, raises it only by an Override",
    schema: SHAPE['limits.maxBoxesPerPerson'],
    default: 3,
    add: replace,
    // A cost limit (ADR 0016, #165): yours may lower it plainly, never raise it.
    guard: {
      from: 'individual',
      needs: (above, next) => (next > above ? `raises the box cap over ${above}` : undefined),
    },
  },
  'limits.maxBoxSize': {
    summary: "the largest box size (the repo's: yours lowers it, raises it only by an Override)",
    schema: SHAPE['limits.maxBoxSize'],
    default: 'm8g.2xlarge',
    add: replace,
    // A cost limit: yours may lower it plainly, never raise it.
    guard: {
      from: 'individual',
      needs: (above, next) =>
        boxSizeRank(next) > boxSizeRank(above) ? `raises the largest box over ${above}` : undefined,
    },
  },
  'limits.maxBoxDisk': {
    summary:
      "the largest a box's root disk grows to by itself, in GB (+20 GB at a time under 20 % free; the repo's: yours lowers it, raises it only by an Override)",
    schema: SHAPE['limits.maxBoxDisk'],
    default: 200,
    add: replace,
    // A cost limit: yours may lower it plainly, never raise it.
    guard: {
      from: 'individual',
      needs: (above, next) =>
        next > above ? `raises the largest box disk over ${above} GB` : undefined,
    },
  },
  'box.size': {
    summary:
      "the size a repo's new box starts at, and a box woken below it is resized to (a heavy repo raises it); never past limits.maxBoxSize",
    schema: SHAPE['box.size'],
    default: 'm8g.xlarge',
    add: replace,
  },
  'box.idleMinutes': {
    summary:
      'minutes a box stays up with no Claude Code hook and no one attached before it stops itself (its disk kept)',
    schema: SHAPE['box.idleMinutes'],
    default: 30,
    add: replace,
    // the box's own, not a repo's (ADR 0030): handed to the box, read there without a checkout
    places: MACHINE,
    // A cost limit: yours may shorten it plainly, never lengthen it.
    guard: {
      from: 'individual',
      needs: (above, next) =>
        next > above ? `keeps an idle box up longer than ${above} min` : undefined,
    },
  },
  'box.waitingMinutes': {
    summary:
      'minutes a box whose session waits on you stays up after it began to wait, even with no hook and no one attached (#192); its idle stop says when, 5 min ahead',
    schema: SHAPE['box.waitingMinutes'],
    default: 120,
    add: replace,
    // the box's own, not a repo's (ADR 0030): handed to the box, read there without a checkout
    places: MACHINE,
    // A cost limit, as box.idleMinutes: yours may shorten it plainly, never lengthen it.
    guard: {
      from: 'individual',
      needs: (above, next) =>
        next > above ? `keeps a box waiting on you up longer than ${above} min` : undefined,
    },
  },
  'box.profile': {
    summary:
      "the AWS profile your boxes are reached on, yours on this machine or for this repo; $ABE_BOX_PROFILE overrides it (a shell's $AWS_PROFILE does not), unset $AWS_PROFILE, else the config's default profile",
    schema: SHAPE['box.profile'],
    default: null,
    add: replace,
    places: ['machine', 'local'],
  },
  'box.region': {
    summary:
      "the AWS region your boxes run in; $AWS_REGION or $AWS_DEFAULT_REGION overrides it, unset the profile's own",
    schema: SHAPE['box.region'],
    default: null,
    add: replace,
    places: MACHINE,
  },
  'box.owner': {
    summary:
      "who your boxes are tagged as (abe:owner): your GitHub login, unset gh's; $ABE_OWNER overrides it (yours alone)",
    schema: SHAPE['box.owner'],
    default: null,
    add: replace,
    places: MACHINE,
  },
  'stores.logs': {
    summary:
      "where session logs are shipped: file://<dir> or s3://<bucket>[/<prefix>]; $ABE_LOG_STORE overrides it; unset, a folder in Abe's state on this machine (a box: none)",
    schema: SHAPE['stores.logs'],
    default: null,
    add: replace,
    places: MACHINE,
  },
  'stores.org': {
    summary:
      'the store prototypes and Sheets go to: file://<dir> or s3://<bucket>[/<prefix>]; $ABE_ORG_STORE overrides it, unset none',
    schema: SHAPE['stores.org'],
    default: null,
    add: replace,
    places: MACHINE,
  },
  'browser.profiles': {
    summary:
      'the browser profiles a verify step can name: { name, purpose }; the repo ships shared ones, yours adds personal ones (a name given above is the same profile)',
    schema: SHAPE['browser.profiles'],
    default: [],
    add: addProfiles,
    // this Mac's Chrome profiles (#345): the repo's shared ones, yours on this Mac over them
    places: ['repo', 'machine'],
  },
  'browser.default': {
    summary:
      'the browser profile a run verifies in when it names none; unset, the built-in default (empty, a fresh profile every start)',
    schema: SHAPE['browser.default'],
    default: null,
    add: replace,
    // this Mac's Chrome profiles (#345): the repo's shared ones, yours on this Mac over them
    places: ['repo', 'machine'],
  },
  skillsOnTop: {
    summary: 'your personal skills and rules on top of a launch',
    schema: SHAPE.skillsOnTop,
    default: false,
    add: replace,
  },
  'session.mcp': {
    summary:
      "the MCP servers a local chat loads (Ask, Improve, a prototype chat): yours (your own user-scope servers and claude.ai connectors) beside Abe's, or abe-only; their tools run outside the sandbox and aren't checked by Abe's fence. A card's session, an install's and a box's load Abe's own and the repo's sources (from your own config) alone. A repo's own (its .mcp.json) never load, in any session",
    schema: SHAPE['session.mcp'],
    default: 'yours',
    add: replace,
    // Tightening is free; yours loosening the repo's abe-only takes an Override (ADR 0010).
    guard: {
      from: 'individual',
      needs: (above, next) =>
        above === 'abe-only' && next === 'yours'
          ? 'loads your MCP servers where the value above keeps them out'
          : undefined,
    },
  },
  'move.leave': {
    summary:
      "what Download locally and Move to cloud leave behind besides core's (node_modules/, builds, .env…): the repo pack's .gitignore-like globs",
    schema: SHAPE['move.leave'],
    default: [],
    add: union,
  },
  'improve.suggest': {
    summary: 'Improve suggests a change to your personal Layer by itself, at most once a day',
    schema: SHAPE['improve.suggest'],
    default: false,
    add: replace,
    // Opting in is yours: the repo never turns suggestions on for you.
    places: MACHINE,
  },
  'improve.issueRepo': {
    summary: "where a wish that needs VimStorm's code is filed as an issue (<owner/repo>)",
    schema: SHAPE['improve.issueRepo'],
    default: 'mkdir-swe/vimstorm',
    add: replace,
    places: MACHINE,
  },
  'gate.testHosts': {
    summary:
      "hosts the app reaches that are test backends: the gate (abe run start, the install's and every card run's) lets them through, as abe install gate --test-host does",
    schema: SHAPE['gate.testHosts'],
    default: [],
    add: union,
  },
  'gate.readOnlyHosts': {
    summary:
      'prod hosts the app only reads from: the gate (abe run start, every card run) lets them through as read-only use instead of warning',
    schema: SHAPE['gate.readOnlyHosts'],
    default: [],
    add: union,
  },
  'ports.fixed': {
    summary:
      "ports the repo's app always takes (an auth redirect registered for that origin): beside what the install read, only one session's app runs at a time, a second abe run start refused naming the session holding them",
    schema: SHAPE['ports.fixed'],
    default: [],
    add: (above: number[], written: number[]) => [...new Set([...above, ...written])],
  },
  'pr.pushTimeout': {
    summary:
      "how long the pr step's git push may take, in minutes: the repo's pre-push hook (its tests) runs inside it; past it the push stops and the run says the hook is slow",
    schema: SHAPE['pr.pushTimeout'],
    default: 15,
    add: replace,
  },
  localMode: {
    summary:
      'local mode, per checkout: Abe reads the board and GitHub as usual but holds every write on this machine, and agents run here only (yours alone; abe local on|off)',
    schema: SHAPE.localMode,
    default: [],
    add: replace,
    places: MACHINE,
  },
  boardReadOnly: {
    summary:
      "the board read-only, per checkout: Abe reads the real board, and every change (a move, a comment, a new card, an edit) stays on this machine, drawn over the board's cards and never sent until you discard it (yours alone; abe board read-only on|off). Local mode makes the board read-only too",
    schema: SHAPE.boardReadOnly,
    default: [],
    add: replace,
    places: MACHINE,
  },
  'prototype.model': {
    summary:
      'the model a prototype session runs on, its subagents too: fast and simple, haiku by default (outside allowedModels: the first allowed); /model in one switches that prototype only',
    schema: SHAPE['prototype.model'],
    default: 'haiku',
    add: replace,
  },
  'prototype.effort': {
    summary: "Claude Code's effort for a new prototype session: low, medium or high",
    schema: SHAPE['prototype.effort'],
    default: 'low',
    add: replace,
  },
  views: {
    summary:
      'your view tweaks: parts of a screen hidden, reordered or relabelled by node id, e.g. [{ screen: factory, node: col:Closed, hide: true }], [{ screen: factory, node: col:Resolved, label: Done }], [{ screen: factory, node: col:Active, order: 0 }]',
    schema: SHAPE.views,
    default: [],
    add: replace,
    places: MACHINE,
    check: (written) => viewProblems(written)[0],
  },
  'ui.theme': {
    summary:
      "the window's theme: a built-in one (islands-dark, islands-light, dark-modern) or a theme file of a Layer (themes/<slug>.json)",
    schema: SHAPE['ui.theme'],
    default: 'islands-dark',
    add: replace,
    places: MACHINE,
  },
  'editor.scheme': {
    summary:
      "the editor's colour scheme: theme (the same as ui.theme, the default) or a theme by its slug whose editor, git, diff and terminal colours the editor takes whatever the theme (Darcula syntax on a light UI)",
    schema: SHAPE['editor.scheme'],
    default: 'theme',
    add: replace,
    places: MACHINE,
  },
  'ui.density': {
    summary: "compact (today's rows, tabs and toolbar) or default (WebStorm's default density)",
    schema: SHAPE['ui.density'],
    default: 'compact',
    add: replace,
    places: MACHINE,
  },
  'ui.font.family': {
    summary: "the UI's font: tree, tabs, popups and Abe's screens",
    schema: SHAPE['ui.font.family'],
    default: 'Inter',
    add: replace,
    places: MACHINE,
  },
  'ui.font.size': {
    summary: "the UI font's size in px",
    schema: SHAPE['ui.font.size'],
    default: 13,
    add: replace,
    places: MACHINE,
  },
  'ui.font.editorFamily': {
    summary: "the editor's and the terminal's font (nvim's guifont and the terminal grid follow)",
    schema: SHAPE['ui.font.editorFamily'],
    default: 'JetBrains Mono',
    add: replace,
    places: MACHINE,
  },
  'ui.font.editorSize': {
    summary: 'the editor and terminal font size in px',
    schema: SHAPE['ui.font.editorSize'],
    default: 13,
    add: replace,
    places: MACHINE,
  },
  'ui.font.ligatures': {
    summary: "the editor font's ligatures (off, as WebStorm's default)",
    schema: SHAPE['ui.font.ligatures'],
    default: false,
    add: replace,
    places: MACHINE,
  },
  'ui.feel': {
    summary:
      'how VimStorm behaves: vimstorm (WebStorm with VimStorm’s Vim keys k l ö ä, leader ,), webstorm (Vim mode off), vscode, or vim (stock Vim keys h j k l, your ~/.config/nvim on top); it sets Vim mode and the tree, tabs and save switches no Layer sets (yours alone)',
    schema: SHAPE['ui.feel'],
    default: 'vimstorm',
    add: replace,
    places: MACHINE,
  },
  'tree.autoReveal': {
    summary: 'the Project tree selects and scrolls to the file you open (VS Code’s autoReveal)',
    schema: SHAPE['tree.autoReveal'],
    default: false,
    add: replace,
    places: MACHINE,
  },
  'tree.singleClick': {
    summary: 'a single click on a file in the Project tree opens it (off: a double click does)',
    schema: SHAPE['tree.singleClick'],
    default: false,
    add: replace,
    places: MACHINE,
  },
  'tree.decorations': {
    summary:
      'how the Project tree marks a changed file: colors (git colours) or letters (the colours and M / U / D at the right)',
    schema: SHAPE['tree.decorations'],
    default: 'colors',
    add: replace,
    places: MACHINE,
  },
  'tree.compactFolders': {
    summary: 'a folder chain with one child each shows as one row (a/b/c)',
    schema: SHAPE['tree.compactFolders'],
    default: false,
    add: replace,
    places: MACHINE,
  },
  'tabs.limit': {
    summary:
      'the most editor tabs per split; past it the least recently used one closes (null: no limit)',
    schema: SHAPE['tabs.limit'],
    default: 10,
    add: replace,
    places: MACHINE,
  },
  'tabs.dirtyDot': {
    summary: "an unsaved file's tab shows ● in place of its × until you hover it",
    schema: SHAPE['tabs.dirtyDot'],
    default: false,
    add: replace,
    places: MACHINE,
  },
  'tabs.preview': {
    summary:
      'a file opened with a single click is a preview tab (italic), replaced by the next one until you edit or pin it',
    schema: SHAPE['tabs.preview'],
    default: false,
    add: replace,
    places: MACHINE,
  },
  'files.autoSave': {
    summary:
      'when an edited file is written: onFocusChange (leaving it or the window, WebStorm), afterDelay (a second after typing stops) or off',
    schema: SHAPE['files.autoSave'],
    default: 'onFocusChange',
    add: replace,
    places: MACHINE,
  },
  'editor.minimap': {
    summary:
      'VS Code’s minimap at the right of each editor split: the file’s lines in small, the visible part as a slider; a click or a drag scrolls',
    schema: SHAPE['editor.minimap'],
    default: false,
    add: replace,
    places: MACHINE,
  },
  'editor.vim': {
    summary:
      "Vim mode: on, nvim's modes with Vim's keys (k l ö ä, leader ,); off, always typing, arrows and Shift+arrows select, the Feel's keymap (#131)",
    schema: SHAPE['editor.vim'],
    default: true,
    add: replace,
    places: MACHINE,
  },
  'chat.openByDefault': {
    summary:
      'the Chat column beside the code and the Board is open when a window starts (off: ⌘4 opens it)',
    schema: SHAPE['chat.openByDefault'],
    default: true,
    add: replace,
    places: MACHINE,
  },
  'chat.width': {
    summary: "the Chat column's width in px, 320 to 640 (dragging its edge sets it)",
    schema: SHAPE['chat.width'],
    default: 420,
    add: replace,
    places: MACHINE,
  },
  'models.coordinator': {
    summary:
      "the coordinator's model: runs the session and decides (outside allowedModels: the first allowed)",
    schema: SHAPE['models.coordinator'],
    default: 'opus',
    add: replace,
  },
  'models.reader': {
    summary: 'the model of subagents that only read (outside allowedModels: the first allowed)',
    schema: SHAPE['models.reader'],
    default: 'sonnet',
    add: replace,
  },
  'models.writer': {
    summary: 'the model of subagents that change files (outside allowedModels: the first allowed)',
    schema: SHAPE['models.writer'],
    default: 'opus',
    add: replace,
  },
  effort: {
    summary:
      "Claude Code's effort for a new session: low, medium or high (a resumed one keeps its own)",
    schema: SHAPE.effort,
    default: 'medium',
    add: replace,
  },
  'subagents.max': {
    summary: 'the most subagents one session runs at once',
    schema: SHAPE['subagents.max'],
    default: SUBAGENTS_DEFAULT,
    add: replace,
  },
  'launch.notes': {
    summary:
      "standing notes: words every launch's agent reads after the card, like a Launch note; a lower Layer adds to them, an Override drops an upper one",
    schema: SHAPE['launch.notes'],
    default: [],
    add: union,
  },
};

/** A key's own row only: `constructor` is no setting. */
export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SHAPE, key);

export const settingKeys = (): SettingKey[] => Object.keys(SHAPE).filter(isSettingKey);

/** The keys as a zod enum, for the contract. */
export const SettingKeyName = z.enum(Object.keys(SHAPE).filter(isSettingKey));

/** Core's defaults: the core Layer. */
export const coreDefaults = (): Settings =>
  SettingsSchema.parse(Object.fromEntries(settingKeys().map((k) => [k, SETTINGS[k].default])));

export const layerIndex = (layer: Layer): number => LAYERS.indexOf(layer);

/** The files a setting is read from (ADR 0030). */
export const placesOf = (key: SettingKey): readonly Place[] => {
  const def: SettingDef<unknown> = SETTINGS[key];

  return def.places ?? FACTORY;
};

/** An editor preference or your environment: read from yours on this Mac alone. */
export const isMachineSetting = (key: SettingKey): boolean => {
  const places = placesOf(key);

  return !places.includes('local') && !places.includes('repo');
};

/** Yours alone, for this repo: never the repo's file. */
export const isMineSetting = (key: SettingKey): boolean => {
  const places = placesOf(key);

  return places.includes('local') && !places.includes('repo');
};

/** The team's (ADR 0031): read from the repo's file alone, never yours. */
export const isTeamSetting = (key: SettingKey): boolean => {
  const places = placesOf(key);

  return places.includes('repo') && !places.includes('local');
};

/** A key whose plain entry only adds to the value above (`checks`, `testFiles`, `reach`…), never replaces it. */
export const addsOnly = (key: SettingKey): boolean => {
  const def: SettingDef<unknown> = SETTINGS[key];

  return def.add !== replace;
};

/** Your gh account for a repo (ADR 0031): `logins.gh`. */
export const githubAccountOf = (
  values: Partial<Pick<Settings, 'logins.gh'>> | undefined,
): string | null => values?.['logins.gh'] ?? null;
