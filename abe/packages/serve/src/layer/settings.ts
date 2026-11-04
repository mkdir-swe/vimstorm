/**
 * `abe settings`: the Layers' files found and read through `ports`, merged by `core`'s rules.
 * A handler reads the settings in force with `ctx.settings.at(ctx.cwd)`, which also has their
 * files watched, so a change to them is a `settings.changed` event.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  type ProfileStore,
  addsNothing,
  type ArgsOf,
  boardOf,
  checkEntries,
  checksExample,
  cutChecks,
  SettingsSchema,
  checkPlan,
  fieldValue,
  type Clock,
  type Commands,
  feelOf,
  type KeyBind,
  keyBinds,
  KEYS_FILE,
  githubRepoOf,
  individualFile,
  isSettingKey,
  listSettings,
  LOCAL_TARGET,
  localCheckoutOf,
  isLocalBoard,
  type LayerPulls,
  type Merged,
  mergeSettings,
  type OpenProposal,
  type Outcome,
  overrideReason,
  type PersonalOverride,
  personalOverrides,
  placeWords,
  problemList,
  proposalBody,
  proposalBranch,
  proposalName,
  proposalTitle,
  proposedValue,
  proposeOffer,
  putEntry,
  putField,
  readProposalKey,
  type Repo,
  type Tracking,
  readValue,
  refused,
  repoFile,
  SettingExplainData,
  SettingGetData,
  settingsProblems,
  settingsScope,
  SETTINGS,
  type SettingKey,
  settingKeys,
  type SettingProblem,
  noThemeText,
  unknownThemeProblem,
  unknownSchemeProblem,
  SAME_AS_THEME,
  SettingValue,
  type SettingsListData,
  type SettingsProposeData,
  shellArg,
  shownValue,
  withProposals,
  type BoxAws,
  type GhAccounts,
  type KnownChoices,
  azureFolderExplain,
  boardFieldExplain,
  BOARD_FIELD_TAKES,
  isAzureFolderField,
  isBoardField,
  type BoardField,
  BoardFieldValue,
  type SettingSetData,
  explainedWithEnvironment,
  PERSONAL_ENV_NOTE,
  writesPersonalEnv,
  type Handlers,
  type Place,
  placesOf,
  isTeamSetting,
  localFile,
  type HandedLayer,
  handedLayer,
  LOCAL_HEADER,
  YOURS_IN_REPO,
  type Layer,
  layerOfPlace,
  dropEntry,
  placeOfFile,
  PROPOSAL_PREFIX,
  PROPOSAL_PATH,
} from '@abe/core';
import {
  findLayerFiles,
  isDirectory,
  mainCheckout,
  originUrl,
  parseYaml,
  readText,
  readYamlFile,
  repoRoot,
  type SettingsPlaces,
  writeYamlFile,
  yamlText,
  excludeInstalled,
  awsConfigNames,
} from '@abe/ports';
import { profileFacts } from '../browser/browser-profiles';
import { type StoredLoginsCtx } from '../logins/logins';
import { azureFolderAt, layerFiles, loadSettings, type SettingsService } from '../settings';
import { readThemes } from '../theme/theme';
import { checkTools, toolsNeededIn, type ToolsCtx } from '../install/tools';
import { loadedWorkflows } from '../skills/workflows';

export {
  azureFolderAt,
  fixedSettings,
  loadSettings,
  startSettings,
  yourOwnSettings,
  type AzFolder,
  type CheckoutFacts,
  type SettingsService,
} from '../settings';

/**
 * The folder a run's or session's settings are read in (ADR 0030: they live in its checkout): its
 * repo when that is a folder, else (a box's: `owner/name`) its worktree there, when it is one.
 */
export const checkoutOf = (o: { repo: string; worktree?: string | undefined }): string =>
  !isAbsolute(o.repo) &&
  o.worktree !== undefined &&
  isAbsolute(o.worktree) &&
  existsSync(o.worktree)
    ? o.worktree
    : o.repo;

export type SettingsCtx = { cwd: string; settings: SettingsService | undefined };

/** Why a checkout's launches stay on this machine whatever `serve.target` says; none: they follow it. */
const launchesHereWhy = (merged: Merged, dir: string): string | null => {
  const local = localCheckoutOf(merged.values.localMode, dir);

  if (local !== undefined)
    return `local mode is on in ${local}: agents run on this machine only (abe local off to launch in your environment)`;
  const board = boardOf(merged.values.board);

  return board.ok && isLocalBoard(board.board)
    ? 'the board is On this machine: agents run on this machine only'
    : null;
};

/**
 * `serve.target` in force in `dir`: the Mac's setting (default `local`; `cloud` is your environment, ADR 0042), `local`
 * where local mode is on or the board is On this machine (a launch there never goes to a box), with
 * why. A box's own serve (`onBox`) is that environment, so it always launches on itself.
 */
export const targetInForce = (
  settings: SettingsService | undefined,
  dir: string,
  onBox: boolean,
): { target: string; why: string | null } => {
  if (onBox) return { target: LOCAL_TARGET, why: null };
  if (settings === undefined) return { target: SETTINGS['serve.target'].default, why: null };
  const merged = settings.at(dir);
  const why = launchesHereWhy(merged, dir);

  return why === null
    ? { target: merged.values['serve.target'], why }
    : { target: LOCAL_TARGET, why };
};

/** `serve.target` in force in `dir` (`targetInForce`). */
export const serveTargetIn = (
  settings: SettingsService | undefined,
  dir: string,
  onBox: boolean,
): string => targetInForce(settings, dir, onBox).target;

/** The settings an Override sets in force in `dir`'s checkout (a Factory run's hard facts, #87). */
export const overridesIn = (settings: SettingsService | undefined, dir: string): string[] => {
  if (settings === undefined) return [];
  const merged = settings.at(dir);

  return settingKeys().filter((key) =>
    merged.explain(key).layers.some((step) => step.entry === 'override' && step.applied),
  );
};

/**
 * Yours as a cloud launch from `where` hands it to its box (#222, ADR 0030): your file on this Mac,
 * and yours for the repo launched from but what is this Mac's alone.
 */
export const yourHandedLayer = (places: SettingsPlaces, where?: string | null): HandedLayer => {
  const docOf = (file: string) => {
    const read = readYamlFile(file);

    return 'doc' in read ? read.doc : undefined;
  };
  const top = where === null || where === undefined ? undefined : repoRoot(where);
  const main = top === undefined ? undefined : (mainCheckout(top) ?? top);

  return handedLayer(
    docOf(individualFile(places.configDir)),
    main === undefined ? undefined : docOf(localFile(main)),
  );
};

/** What a Factory run launched in `dir` keeps of the Overrides there: the keys, and yours (#168). */
export type RunOverrides = { keys: readonly string[]; personal: readonly PersonalOverride[] };

/** Settings a Factory run does not read: an Override of one is no fact of the run. */
const RUN_IGNORES: readonly string[] = ['session.mcp'];

export const runOverridesIn = (
  settings: SettingsService | undefined,
  dir: string,
): RunOverrides => ({
  keys: overridesIn(settings, dir).filter((key) => !RUN_IGNORES.includes(key)),
  personal:
    settings === undefined
      ? []
      : personalOverrides(settings.at(dir)).filter((o) => !RUN_IGNORES.includes(o.key)),
});

/** Your Layer's keys.json as the shell binds it (#129); none when it is not there or not JSON. */
const yourKeys = (configDir: string): KeyBind[] => {
  const text = readText(join(configDir, KEYS_FILE));

  if (text === undefined) return [];
  try {
    return keyBinds(JSON.parse(text));
  } catch {
    return [];
  }
};

const noSettings = () =>
  Promise.resolve(refused('no-settings', 'this abe serve was started without its settings'));

/** `ui.theme` (#172) or `editor.scheme` (#345) in force naming no theme yours or a built-in has. */
const themeProblems = (merged: Merged, settings: SettingsService): SettingProblem[] => {
  const { catalogue } = readThemes(settings.places);

  return [unknownThemeProblem(merged, catalogue), unknownSchemeProblem(merged, catalogue)].filter(
    (p) => p !== undefined,
  );
};

/** Why `slug` is no theme to set, with the themes there are; `undefined` when it is one. */
const missingTheme = (slug: string, settings: SettingsService): string | undefined => {
  const { catalogue } = readThemes(settings.places);

  return catalogue.some((t) => t.slug === slug) ? undefined : noThemeText(slug, catalogue);
};

const unknown = (key: string) =>
  Promise.resolve(refused('unknown-setting', `${key} is not a setting`));

/**
 * What `settings problems` reads beside the settings: the logins' and the tools' checks; and
 * `settings propose` / `list`: the Layers' repos on GitHub, for their pull requests.
 */
export type ProblemsCtx = SettingsCtx &
  StoredLoginsCtx &
  ToolsCtx & {
    ports: {
      layerPulls: LayerPulls | undefined;
      tracking: Tracking;
      /** Your gh logins (Settings' account combos offer them); none: not known. */
      github?: { accounts?: (() => Promise<GhAccounts>) | undefined } | undefined;
      /** The Mac's AWS profile and region for boxes (#158); `undefined`: not checked. */
      awsReach?: (() => BoxAws) | undefined;
    };
    serve: {
      clock: Clock;
      /** Your stored browser sign-ins (#345: a profile never stored is a problem on the Mac). */
      profileStore?: ProfileStore | undefined;
      /**
       * The Mac database (#349): what a checkout needs, whether Docker answers, and whether serve's
       * own environment has a `DATABASE_URL` (ignored); `undefined` on a box.
       */
      macDatabase?:
        | {
            needs: (dir: string) => boolean;
            docker: () => Promise<'up' | 'down' | 'missing'>;
            served: boolean;
          }
        | undefined;
    };
  };

/**
 * The setup as Problems reads it (#158): the board and, on the Mac, the AWS boxes are reached on.
 * Not on a box (its serve is that environment).
 */
const setupFacts = (merged: Merged, ctx: ProblemsCtx & { settings: SettingsService }) => {
  if (ctx.serve.onBox) return undefined;
  const board = boardOf(merged.values.board);

  return {
    board: board.ok ? null : board.error.message,
    ...(ctx.ports.awsReach === undefined
      ? {}
      : {
          cloud: { target: serveTargetIn(ctx.settings, ctx.cwd, false), ...ctx.ports.awsReach() },
        }),
  };
};

type Writing = SettingsCtx & { settings: SettingsService };

/** The flags a write or unset takes (ADR 0030): `--here` is `--mine`. */
type PlaceFlags = {
  repo?: boolean | undefined;
  mine?: boolean | undefined;
  here?: boolean | undefined;
};

/**
 * The file a write of `key` in `cwd` goes to: `--repo` the repo's, `--mine` yours for this repo;
 * neither, yours on this Mac for an editor preference, except in a checkout for a key the repo's
 * file decides over it (`serve.target`, 3.2.2: yours for this repo, so the write takes effect),
 * else yours for this repo. A file that may not hold the key refuses it in the merge, saying why.
 */
const placeFor = (key: SettingKey, flags: PlaceFlags, cwd: string): Outcome<Place> => {
  const mine = flags.mine === true || flags.here === true;

  if (flags.repo === true && mine) return refused('usage', '--repo or --mine, not both', 2);
  if (flags.repo === true) return { ok: true, data: 'repo' };
  if (mine) return { ok: true, data: 'local' };
  const places = placesOf(key);

  if (places.includes('machine')) {
    const macFirst = places.includes('repo') && places.indexOf('machine') < places.indexOf('repo');

    return {
      ok: true,
      data:
        macFirst && places.includes('local') && repoRoot(resolve(cwd)) !== undefined
          ? 'local'
          : 'machine',
    };
  }

  return { ok: true, data: isTeamSetting(key) ? 'repo' : 'local' };
};

/** The file at `place` for work in `cwd`, or why there is none (outside a checkout). */
const fileAt = (
  place: Place,
  ctx: Writing,
): Outcome<{ file: string; repo: string | undefined }> => {
  const repo = repoRoot(resolve(ctx.cwd));
  const file = layerFiles(ctx.settings.places, repo, readYamlFile).files[place];

  return file === undefined
    ? refused(
        'not-a-checkout',
        `${ctx.cwd} is in no checkout: --repo and --mine write the repo's .abe/ files`,
      )
    : { ok: true, data: { file, repo } };
};

/** Yours for this repo starts with its header and is kept out of git (ADR 0030). */
const keepLocal = (file: string) => {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, LOCAL_HEADER);
  }
  excludeInstalled(dirname(dirname(file)), YOURS_IN_REPO);
};

/** The problems that say a key is not read from a file at all. */
const PLACE_CODES: ReadonlySet<string> = new Set(['personal-only', 'not-in-repo', 'team-only']);

/**
 * `change` applied to the file at `place`, checked by the merge, then written: refused when the
 * file may not hold the key (`problemKey`'s problem), when yours loosens a value above without an
 * Override (#168), or when a plain list entry adds nothing (#173).
 */
const writeAt = (
  o: {
    key: string;
    problemKey: SettingKey;
    place: Place;
    change: (doc: unknown) => unknown;
    written: unknown;
    /** The value in force after, and its Layer, as the key reads it. */
    after: (merged: Merged) => { value: unknown; winner: Layer };
    entry: 'plain' | 'override';
    reason: string | null;
    typed?: string;
    note?: string;
  },
  ctx: Writing,
): Outcome<SettingSetData> => {
  const at = fileAt(o.place, ctx);

  if (!at.ok) return at;
  const { file, repo } = at.data;
  const { places } = ctx.settings;
  const current = readYamlFile(file);

  if ('error' in current) return refused('bad-layer-file', `${file}: ${current.error}`);
  // a key this file is not read for, refused as its dotted entry would be: `logins.gh` written
  // nested into the repo's file would read as the team's `logins`, never as a problem
  const misplaced = mergeSettings([
    { place: o.place, file, doc: { [o.problemKey]: o.written } },
  ]).problems.find((p) => p.key === o.problemKey && PLACE_CODES.has(p.code));

  if (misplaced !== undefined) return refused(misplaced.code, misplaced.message);
  const doc = o.change(current.doc);
  const merged = loadSettings(places, repo, (f) => (f === file ? { doc } : readYamlFile(f)));
  const problem = merged.problems.find((p) => p.file === file && p.key === o.problemKey);
  const layer = layerOfPlace(o.place);

  // Yours loosening a value above (#168): allowed, as an Override with its reason.
  if (problem?.code === 'override-required' && layer === 'individual' && o.typed !== undefined)
    return refused('reason-required', yourOverrideText(o.key, o.typed, problem));
  if (problem !== undefined) return refused(problem.code, problem.message);
  if (o.entry === 'plain' && o.typed !== undefined && isSettingKey(o.key)) {
    const key = o.key;
    // what this file adds to the ones above it: yours left out of the repo's (#173)
    const upTo = layer === 'repo' ? merged.without('individual') : merged;
    const nothing = addsNothing({
      key,
      typed: o.typed,
      written: o.written,
      above: upTo.without(layer).values[key],
      after: upTo.values[key],
    });

    if (nothing !== undefined) return refused('override-required', nothing);
  }
  if (o.place === 'local') keepLocal(file);
  writeYamlFile(file, doc);
  // the snapshot made again now: the next lookup sees this write
  ctx.settings.poll();
  const after = o.after(merged);

  return {
    ok: true,
    data: {
      key: o.key,
      layer,
      place: o.place,
      file,
      entry: o.entry,
      written: SettingValue.parse(o.written),
      reason: o.reason,
      value: SettingValue.parse(after.value),
      winner: after.winner,
      ...(o.note === undefined ? {} : { note: o.note }),
    },
  };
};

/** A key's value in force after a write, and the Layer it comes from. */
const keyAfter = (key: SettingKey) => (merged: Merged) => ({
  value: merged.values[key],
  winner: merged.explain(key).winner,
});

/** `board.azureConfigDir` in force after a write: your az folder alone, not the rest of `board`. */
const azAfter = (merged: Merged) => {
  const e = azureFolderExplain(SettingExplainData.parse(merged.explain('board')));

  return { value: e.value, winner: e.winner };
};

const AZ = 'board.azureConfigDir';

/** Your az folder as typed: a folder, or `null` (none). */
const typedAzFolder = (typed: string): Outcome<string | null> => {
  const t = typed.trim();

  if (t === 'null' || t === '') return { ok: true, data: null };

  return { ok: true, data: t };
};

/**
 * `abe settings set board.azureConfigDir <dir>`: your az folder for this repo, `board`'s field in
 * yours for this repo (ADR 0030). Yours alone: never `--repo`, no Override.
 */
const setYourAzFolder = (
  args: ArgsOf<Commands['settings set']['args']>,
  ctx: Writing,
): Outcome<SettingSetData> => {
  if (args.repo)
    return refused('personal-only', `${AZ} is yours alone: set it with --mine, never --repo`);
  if (args.override || args.reason !== undefined)
    return refused('usage', `${AZ} takes no Override: it is yours alone, set it plainly`, 2);
  const read = typedAzFolder(args.value);

  if (!read.ok) return read;

  return writeAt(
    {
      key: AZ,
      problemKey: 'board',
      place: 'local',
      change: (doc) => putField(doc, 'board', 'azureConfigDir', read.data),
      written: read.data,
      after: azAfter,
      entry: 'plain',
      reason: null,
    },
    ctx,
  );
};

/** A board field in force after a write, and `board`'s Layer. */
const boardFieldAfter = (key: BoardField) => (merged: Merged) => {
  const board: Record<string, unknown> = merged.values.board;

  return {
    value: board[key.slice('board.'.length)] ?? null,
    winner: merged.explain('board').winner,
  };
};

/**
 * `abe settings set board.area <path> | board.tag <tag> | board.excludeLanes <lanes> |
 * board.notTag <tag>` (or unset, `value` null): `board`'s field in the repo's file by default, the
 * rest of `board` kept.
 */
const setBoardField = (
  key: BoardField,
  value: string | null,
  flags: PlaceFlags,
  ctx: Writing,
): Outcome<SettingSetData> => {
  const parsed = value === null ? undefined : parseYaml(value);
  const typed = parsed === undefined || !('doc' in parsed) ? value : parsed.doc;
  const read =
    typed === null ? { success: true as const, data: null } : BoardFieldValue[key].safeParse(typed);

  if (!read.success)
    return refused('invalid-setting', `${key} ${value ?? ''}: ${BOARD_FIELD_TAKES[key]}`);
  const place = placeFor('board', flags, ctx.cwd);

  if (!place.ok) return place;

  return writeAt(
    {
      key,
      problemKey: 'board',
      place: place.data,
      change: (doc) => putField(doc, 'board', key.slice('board.'.length), read.data),
      written: read.data,
      after: boardFieldAfter(key),
      entry: 'plain',
      reason: null,
    },
    ctx,
  );
};

/**
 * Yours for the repo at `top` (ADR 0030): what the install sets itself (the gh login that reads
 * the repo, the env files), as `abe settings set <key> <value> --mine` typed there writes it.
 */
export const setYoursAt = (
  ctx: Writing,
  top: string,
  key: SettingKey,
  value: unknown,
): Outcome<SettingSetData> =>
  writeAt(
    {
      key,
      problemKey: key,
      place: 'local',
      change: (doc) =>
        value === null ? dropEntry(doc, key) : putEntry(doc, key, { kind: 'plain', value }),
      written: value,
      after: keyAfter(key),
      entry: 'plain',
      reason: null,
    },
    { ...ctx, cwd: top },
  );

/**
 * The repo's for the main checkout at `top` (ADR 0031): what the install writes for the team (its
 * `sources:`), as `abe settings set <key> <value> --repo` typed there writes it.
 */
export const setRepoAt = (
  ctx: Writing,
  top: string,
  key: SettingKey,
  value: unknown,
): Outcome<SettingSetData> =>
  writeAt(
    {
      key,
      problemKey: key,
      place: 'repo',
      change: (doc) =>
        value === null ? dropEntry(doc, key) : putEntry(doc, key, { kind: 'plain', value }),
      written: value,
      after: keyAfter(key),
      entry: 'plain',
      reason: null,
    },
    { ...ctx, cwd: top },
  );

/** `abe settings unset <key> [--repo|--mine]`: its entry out of that file, plain or Override. */
const unset = (
  args: ArgsOf<Commands['settings unset']['args']>,
  ctx: Writing,
): Outcome<SettingSetData> => {
  const { key } = args;

  if (isAzureFolderField(key))
    return writeAt(
      {
        key,
        problemKey: 'board',
        place: 'local',
        change: (doc) => putField(doc, 'board', 'azureConfigDir', null),
        written: null,
        after: azAfter,
        entry: 'plain',
        reason: null,
      },
      ctx,
    );
  if (isBoardField(key)) return setBoardField(key, null, args, ctx);
  if (!isSettingKey(key)) return refused('unknown-setting', `${key} is not a setting`);
  const place = placeFor(key, args, ctx.cwd);

  if (!place.ok) return place;

  return writeAt(
    {
      key,
      problemKey: key,
      place: place.data,
      change: (doc) => dropEntry(doc, key),
      written: null,
      after: keyAfter(key),
      entry: 'plain',
      reason: null,
    },
    ctx,
  );
};

/** The settings files under `dir` (or `dir` itself, one file) and their problems. */
export const checkLayerFiles = (
  dir: string,
): { files: string[]; problems: SettingProblem[] } | undefined => {
  const lone = !isDirectory(dir);

  if (lone && readText(dir) === undefined) return undefined;
  const plan = lone ? [{ file: dir, place: placeOfFile(dir) }] : checkPlan(findLayerFiles(dir));

  if (plan.length === 0) return undefined;

  return {
    files: plan.map((step) => step.file),
    problems: plan.flatMap((step) =>
      mergeSettings([
        { place: step.place, file: step.file, ...readYamlFile(step.file) },
      ]).problems.filter((p) => p.file === step.file),
    ),
  };
};

/** A checkout's `package.json` scripts, for a minimal pack's commands; none when it has none. */
const packageScripts = (dir: string): Record<string, unknown> => {
  const text = readText(join(dir, 'package.json'));

  if (text === undefined) return {};
  try {
    const doc: unknown = JSON.parse(text);
    const scripts =
      typeof doc === 'object' && doc !== null && 'scripts' in doc ? doc.scripts : undefined;

    return typeof scripts === 'object' && scripts !== null ? { ...scripts } : {};
  } catch {
    return {};
  }
};

/**
 * `settings check` on a folder with no layer file (#159): what the repo Layer is, that it is
 * optional, what is lost without one, and a minimal one from the checkout's scripts.
 */
export const noLayerFileText = (dir: string): string => {
  const repo = repoRoot(dir);

  return [
    `no layer file in ${dir}.`,
    `A repo's Layer is ${repo === undefined ? '<repo>' : repoFile(repo)}. It is optional, but without one no check has a command: a Factory run's checks run no test, typecheck or lint, its pull request says nothing was run, and a person merges it. A minimal one:`,
    '',
    checksExample(repo === undefined ? {} : packageScripts(repo)).trimEnd(),
  ].join('\n');
};

/** Refused when this `serve` has no GitHub for a Layer's pull requests (`propose`, retro `make`). */
export const noLayerPulls = () =>
  refused('no-github', 'this abe serve was started without GitHub for a Layer’s pull requests');

/** A checkout's repo on GitHub, from its origin remote. */
export const githubOf = async (dir: string): Promise<Outcome<Repo>> => {
  const url = await originUrl(dir);

  if (url === undefined) return refused('no-origin', `${dir} has no origin remote`);
  const repo = githubRepoOf(url);

  return repo === undefined
    ? refused('not-github', `${dir}'s origin is not on GitHub: ${url}`)
    : { ok: true, data: repo };
};

/** Where a proposal goes: the repo's file here, and its GitHub repo. */
type Target = { local: string; github: Repo; where: string };

const targetOf = async (repoDir: string | undefined): Promise<Outcome<Target>> => {
  if (repoDir === undefined)
    return refused('not-in-repo', 'not in a git checkout, so there is no repo to propose to');
  const github = await githubOf(repoDir);

  return github.ok
    ? {
        ok: true,
        data: { local: repoFile(repoDir), github: github.data, where: placeWords(github.data) },
      }
    : github;
};

const fromGh = (e: { error: { code: string; message: string } }) =>
  refused(e.error.code, e.error.message);

/** A Layer's text read from GitHub as a document, or refused when it does not read. */
const docOfText = (text: string | null, where: string): Outcome<unknown> => {
  if (text === null) return { ok: true, data: undefined };
  const read = parseYaml(text);

  return 'error' in read
    ? refused('bad-layer-file', `${where}: ${read.error}`)
    : { ok: true, data: read.doc };
};

/** How long `settings list` waits on GitHub for the open pull requests before listing without them. */
const OPEN_WAIT_MS = 5_000;

/** The repo's open proposals, by branch; none when its repo or GitHub does not answer in time. */
const openOf = async (
  pulls: LayerPulls,
  target: Outcome<Target>,
): Promise<readonly OpenProposal[]> => {
  if (!target.ok) return [];
  const open = await Promise.race([
    pulls.open(target.data.github, PROPOSAL_PREFIX),
    Bun.sleep(OPEN_WAIT_MS).then(() => undefined),
  ]);

  return open?.ok === true ? open.data : [];
};

/**
 * What serve knows on this Mac that Settings' combos offer: your gh logins, your AWS config's
 * profiles and regions (names only). None on a box, nor in a serve started without its environment.
 */
const knownChoices = async (
  ctx: ProblemsCtx & { settings: SettingsService },
): Promise<KnownChoices> => {
  if (ctx.serve.onBox) return {};
  const accounts = await ctx.ports.github?.accounts?.().catch(() => undefined);

  return { ...(accounts === undefined ? {} : { gh: accounts.signedIn }), ...awsKnown(ctx) };
};

/** Your AWS config's profiles and regions: a file read, no aws run. */
const awsKnown = (ctx: ProblemsCtx & { settings: SettingsService }): KnownChoices => {
  const env = ctx.settings.environment;

  return ctx.serve.onBox || env === undefined ? {} : awsConfigNames(env, ctx.settings.places.home);
};

/**
 * `settings list` with the open pull requests proposing its rows (#108 S3), the checkout's repo
 * named as GitHub names it (#175: never a clone's or worktree's folder).
 */
const listed = async (
  merged: Merged,
  ctx: ProblemsCtx & { settings: SettingsService },
  filesOnly: boolean,
) => {
  const repoDir = repoRoot(resolve(ctx.cwd));
  const [github, known] = await Promise.all([
    repoDir === undefined ? undefined : githubOf(repoDir),
    filesOnly ? awsKnown(ctx) : knownChoices(ctx),
  ]);
  const data: SettingsListData = listSettings(
    merged,
    github?.ok === true ? github.data : undefined,
    known,
  );
  const pulls = ctx.ports.layerPulls;

  if (pulls === undefined || repoDir === undefined || filesOnly) return data;

  return withProposals(data, await openOf(pulls, await targetOf(repoDir)));
};

/**
 * `settings propose`: the repo's file as its default branch has it, with the setting put (an
 * Override with the reason where a plain entry may not lower the value above), checked, as one
 * pull request; one open for it already is updated.
 */
const propose = async (
  args: ArgsOf<Commands['settings propose']['args']>,
  ctx: ProblemsCtx & { settings: SettingsService },
): Promise<Outcome<SettingsProposeData>> => {
  const typed = readProposalKey(args.key);

  if (typed === undefined) return unknown(args.key);
  const { key, field } = typed;
  const merged = ctx.settings.at(ctx.cwd);
  const rows = listSettings(merged).rows;
  const row = rows.find((r) => r.key === key && r.field === field);

  if (field !== null && row === undefined)
    return refused('unknown-setting', `${key} has no field ${field} in Settings`);
  const repoDir = repoRoot(resolve(ctx.cwd));
  const offer = proposeOffer({ key, repo: repoDir ?? null });

  if (!offer.ok) return refused(offer.code, `${args.key}: ${offer.message}`);
  const reason = overrideReason(args.reason);

  if (reason === undefined)
    return refused(
      'reason-required',
      'a proposal needs a non-empty --reason: the pull request opens with it',
    );
  const pulls = ctx.ports.layerPulls;

  if (pulls === undefined) return noLayerPulls();
  const target = await targetOf(repoDir);

  if (!target.ok) return target;
  const { local, github, where } = target.data;
  const path = PROPOSAL_PATH;
  const parsed = parseYaml(args.value);
  /** The entry put into `doc` (the repo's file), checked over core alone. */
  const put = (doc: unknown) => {
    const value = proposedValue({
      key,
      field,
      doc,
      parsed: 'doc' in parsed ? parsed.doc : args.value,
      typed: args.value,
    });

    if (!value.ok) return refused('invalid-setting', `${args.key} ${args.value}: ${value.message}`);
    const merge = (next: unknown) => mergeSettings([{ place: 'repo', file: local, doc: next }]);
    const problemOf = (next: unknown) =>
      merge(next).problems.find((p) => p.file === local && p.key === key);
    const plain = putEntry(doc, key, { kind: 'plain', value: value.value });
    // A plain checks entry never drops a check (#168: a cut is proposed as the Override it needs).
    const typedChecks = SettingsSchema.shape.checks.safeParse(value.value);
    const cuts =
      key === 'checks' &&
      typedChecks.success &&
      cutChecks(merge(plain).values.checks, typedChecks.data) !== undefined;
    const needsOverride = cuts || problemOf(plain)?.code === 'override-required';
    const next = needsOverride
      ? putEntry(doc, key, {
          kind: 'override',
          value: value.value,
          reason,
          since: new Date(ctx.serve.clock.now()).toISOString(),
        })
      : plain;
    const problem = problemOf(next);

    return problem === undefined
      ? { ok: true as const, data: { value: value.value, next, needsOverride } }
      : refused(problem.code, problem.message);
  };
  // Checked on the file here first (#175): a value that cannot be proposed is told before GitHub.
  const localDoc = readYamlFile(local);
  const early = put('doc' in localDoc ? localDoc.doc : undefined);

  if (!early.ok) return early;
  const base = await pulls.base(github);

  if (!base.ok) return fromGh(base);
  const now = await pulls.show(github, base.data.sha, path);

  if (!now.ok) return fromGh(now);
  const doc = docOfText(now.data, `${github}:${path}`);

  if (!doc.ok) return doc;
  const checked = put(doc.data);

  if (!checked.ok) return checked;
  const { value, next, needsOverride } = checked.data;
  const branch = proposalBranch(proposalName(key, field));
  const open = await ctx.ports.tracking.prFind({ repo: github, head: branch });

  if (!open.ok) return fromGh(open);
  const pull = open.data ?? undefined;
  const label = row?.label ?? key;
  // What the repo gives now: the value above yours.
  const from = shownValue(fieldValue(merged.without('individual').values[key], field));
  const shown = shownValue(fieldValue(value, field));
  const title = proposalTitle({ where, label, value: shown });
  const pr = await pulls.propose({
    repo: github,
    base: base.data,
    branch,
    title,
    body: proposalBody({
      reason,
      name: proposalName(key, field),
      label,
      from,
      value: shown,
      where,
      path,
    }),
    message: title,
    label: null,
    files: [{ path, content: yamlText(now.data ?? undefined, next) }],
    ...(pull === undefined ? {} : { pull: pull.number }),
  });

  if (!pr.ok) return fromGh(pr);

  return {
    ok: true,
    data: {
      key,
      field,
      label,
      repo: github,
      path,
      branch,
      base: base.data.branch,
      from,
      value: shown,
      entry: needsOverride ? 'override' : 'plain',
      pr: pr.data,
      updated: pull !== undefined,
    },
  };
};

/**
 * A plain entry of yours that loosens a value above, refused (#168): it is yours to set, as an
 * Override with the reason why; the command that does it.
 */
const yourOverrideText = (key: string, typed: string, p: SettingProblem): string => {
  const message = p.message.startsWith(`${p.file}: `)
    ? p.message.slice(p.file.length + 2)
    : p.message;
  const why = message.replace(/; the \w+ value stays in force$/, '');

  return `${why}; yours to set as an Override, with its reason: abe settings set ${key} ${shellArg(typed)} --override --reason "<why>"`;
};

export const settingsHandlers = <Ctx extends ProblemsCtx>() =>
  ({
    'settings list': async (args, ctx) => {
      const settings = ctx.settings;

      if (settings === undefined) return noSettings();

      return {
        ok: true,
        data: await listed(settings.at(ctx.cwd), { ...ctx, settings }, args.filesOnly),
      };
    },
    'settings propose': (args, ctx) => {
      const settings = ctx.settings;

      return settings === undefined ? noSettings() : propose(args, { ...ctx, settings });
    },
    'settings problems': async (args, ctx) => {
      if (ctx.settings === undefined) return noSettings();
      const merged = ctx.settings.at(ctx.cwd);
      const scope = settingsScope(merged);
      const repo = repoRoot(resolve(ctx.cwd));
      // Checked each time it is asked (Settings opening), never in the background; with
      // --files-only only the snapshot's own, at once (the checks take seconds)
      const checks = !args.filesOnly;
      const setup = setupFacts(merged, { ...ctx, settings: ctx.settings });
      const mac = checks ? ctx.serve.macDatabase : undefined;
      const needs = repo !== undefined && (mac?.needs(repo) ?? false);
      const [logins, tools, docker, browser] = await Promise.all([
        // az checked in the folder in force here (ADR 0025)
        checks
          ? ctx.serve.storedLogins?.status({ azureFolder: azureFolderAt(ctx.settings, ctx.cwd) })
          : undefined,
        ctx.serve.toolProbe === undefined || !checks
          ? undefined
          : checkTools(ctx.serve.toolProbe, ctx.serve.onBox, toolsNeededIn(ctx.settings, ctx.cwd)),
        needs && mac !== undefined ? mac.docker() : Promise.resolve('up' as const),
        // #345: browser profiles on the Mac (a box restores what the Mac stored)
        ctx.serve.onBox || !checks
          ? undefined
          : profileFacts(ctx.settings, ctx.cwd, ctx.serve.profileStore),
      ]);

      return {
        ok: true,
        data: {
          problems: settingsProblems({
            settings: [...merged.problems, ...themeProblems(merged, ctx.settings)],
            ...(logins === undefined ? {} : { logins }),
            ...(tools === undefined ? {} : { tools: tools.tools }),
            // #159: the checkout's repo with no check that has a command, pack or not
            ...(repo === undefined
              ? {}
              : { checks: { repo: basename(repo), entries: checkEntries(merged.values.checks) } }),
            // #349: Docker for a repo that needs a database; serve's own DATABASE_URL ignored
            ...(mac === undefined
              ? {}
              : {
                  database: {
                    repo: repo === undefined ? null : basename(repo),
                    needs,
                    docker,
                    served: mac.served,
                  },
                }),
            // #168: each of your Overrides in force, an info row
            overrides: personalOverrides(merged),
            ...(setup === undefined ? {} : { setup }),
            ...(browser === undefined ? {} : { browser }),
            // #15: workflow files failing their load check, each at its file and line
            workflows: loadedWorkflows(ctx.settings, repo).problems,
            scope: { repo: scope.repo, home: ctx.settings.places.home },
          }),
          checked: { logins: logins !== undefined, tools: tools !== undefined },
        },
      };
    },
    'settings feel': (_, ctx) =>
      ctx.settings === undefined
        ? noSettings()
        : Promise.resolve({
            ok: true,
            data: feelOf(ctx.settings.at(ctx.cwd).values, yourKeys(ctx.settings.places.configDir)),
          }),
    'settings get': (args, ctx) => {
      if (ctx.settings === undefined) return noSettings();
      const merged = ctx.settings.at(ctx.cwd);
      // a checkout-only field, like board.azureConfigDir, is read as the key it is
      const key = isAzureFolderField(args.key) || isBoardField(args.key) ? 'board' : args.key;

      if (!isSettingKey(key)) return unknown(args.key);
      const explained = SettingExplainData.parse(merged.explain(key));

      if (isBoardField(args.key)) {
        const field = boardFieldAfter(args.key)(merged);

        return Promise.resolve({
          ok: true,
          data: SettingGetData.parse({
            key: args.key,
            value: field.value,
            layer: field.winner,
            lowered: explained.lowered,
            problems: explained.problems,
          }),
        });
      }
      const e = isAzureFolderField(args.key) ? azureFolderExplain(explained) : explained;
      // where launches go: local where local mode or a board On this machine keeps them here
      const here = key === 'serve.target' ? launchesHereWhy(merged, ctx.cwd) : null;

      return Promise.resolve({
        ok: true,
        data: SettingGetData.parse({
          key: e.key,
          value: here === null ? e.value : LOCAL_TARGET,
          layer: e.winner,
          lowered: here ?? e.lowered,
          problems: e.problems,
        }),
      });
    },
    'settings explain': (args, ctx) => {
      if (ctx.settings === undefined) return noSettings();
      // a board field (board.area, board.excludeLanes, …) is explained as its part of the board
      const field = isAzureFolderField(args.key) || isBoardField(args.key) ? args.key : undefined;
      const key = field === undefined ? args.key : 'board';

      if (!isSettingKey(key)) return unknown(args.key);
      const explained = explainedWithEnvironment(
        SettingExplainData.parse(ctx.settings.at(ctx.cwd).explain(key)),
        ctx.settings.environment ?? {},
      );

      return Promise.resolve({
        ok: true,
        data:
          field === undefined
            ? { ...explained, about: SETTINGS[key].summary }
            : boardFieldExplain(explained, field),
      });
    },
    'settings unset': (args, ctx) =>
      ctx.settings === undefined
        ? noSettings()
        : Promise.resolve(unset(args, { ...ctx, settings: ctx.settings })),
    'settings set': (args, ctx) => {
      if (ctx.settings === undefined) return noSettings();
      const writing = { ...ctx, settings: ctx.settings };
      const { key, value: typed, override } = args;

      if (isAzureFolderField(key)) return Promise.resolve(setYourAzFolder(args, writing));
      if (isBoardField(key))
        return Promise.resolve(
          args.override || args.reason !== undefined
            ? refused('usage', `${key} takes no Override: set it plainly`, 2)
            : setBoardField(key, typed, args, writing),
        );
      if (!isSettingKey(key)) return unknown(key);
      if (args.reason !== undefined && !override)
        return Promise.resolve(refused('usage', '--reason goes with --override', 2));
      const reason = overrideReason(args.reason);

      if (override && reason === undefined)
        return Promise.resolve(
          refused('reason-required', `an Override of ${key} needs a non-empty --reason`),
        );
      const parsed = parseYaml(typed);
      const read = readValue(key, 'doc' in parsed ? parsed.doc : typed, typed);

      if (!read.ok)
        return Promise.resolve(refused('invalid-setting', `${key} ${typed}: ${read.message}`));
      const names =
        key === 'ui.theme' || (key === 'editor.scheme' && typed.trim() !== SAME_AS_THEME);
      const theme = names ? missingTheme(typed.trim(), ctx.settings) : undefined;

      if (theme !== undefined)
        return Promise.resolve(refused('invalid-setting', `${key} ${typed}: ${theme}`));
      const place = placeFor(key, args, ctx.cwd);

      if (!place.ok) return Promise.resolve(place);

      return Promise.resolve(
        writeAt(
          {
            key,
            problemKey: key,
            place: place.data,
            change: (doc) =>
              putEntry(
                doc,
                key,
                reason === undefined
                  ? { kind: 'plain', value: read.value }
                  : {
                      kind: 'override',
                      value: read.value,
                      reason,
                      since: new Date(ctx.serve.clock.now()).toISOString(),
                    },
              ),
            written: read.value,
            after: keyAfter(key),
            entry: reason === undefined ? 'plain' : 'override',
            reason: reason ?? null,
            typed,
            ...(writesPersonalEnv(key, read.value) ? { note: PERSONAL_ENV_NOTE } : {}),
          },
          writing,
        ),
      );
    },
    'settings check': (args, ctx) => {
      const dir = isAbsolute(args.dir) ? args.dir : resolve(ctx.cwd, args.dir);
      const checked = checkLayerFiles(dir);

      if (checked === undefined)
        return Promise.resolve(refused('no-layer-files', noLayerFileText(dir)));
      const [first] = checked.problems;

      if (first !== undefined)
        return Promise.resolve(refused(first.code, problemList(checked.problems)));

      return Promise.resolve({ ok: true, data: { files: checked.files } });
    },
  }) satisfies Partial<Handlers<Ctx>>;
