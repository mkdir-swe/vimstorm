/**
 * The settings in force at a checkout: one merged snapshot per checkout, made at its first lookup
 * and made again only when the poll finds one of its files changed. A lookup reads no file.
 * Beside the values, the facts serve derives from them there (`CheckoutFacts`), so every command
 * agrees on them.
 */
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ABE_ENVS,
  type AbeEnv,
  agentEnvKey,
  githubAccountOf,
  githubBoardFilled,
  individualFile,
  type LayerSource,
  localCheckoutOf,
  localFile,
  type Merged,
  mergeSettings,
  type Place,
  PLACES,
  repoFile,
  type SettingKey,
  settingKeys,
  type Settings,
  type SettingsChangedData,
} from '@abe/core';
import {
  mainCheckout,
  originOfGitConfig,
  parseYaml,
  readText,
  readYamlFile,
  repoRoot,
  type SettingsPlaces,
  type YamlRead,
} from '@abe/ports';

/** Reads one settings file; the watcher hands in one that reads each file once per poll. */
type Read = (file: string) => YamlRead;

const source = (place: Place, file: string, read: Read): LayerSource => ({
  place,
  file,
  ...read(file),
});

/**
 * Each settings file for work in `repo` (ADR 0030): the repo's `abe.yaml` (the checkout's
 * own, else its main checkout's), yours on this Mac, and yours for this repo in the main checkout.
 */
export const layerFiles = (
  places: SettingsPlaces,
  repo: string | undefined,
  read: Read,
): { files: Partial<Record<Place, string>>; sources: LayerSource[] } => {
  const files: Partial<Record<Place, string>> = { machine: individualFile(places.configDir) };

  if (repo !== undefined) {
    const main = mainCheckout(repo) ?? repo;

    files.repo = existsSync(repoFile(repo)) || main === repo ? repoFile(repo) : repoFile(main);
    files.local = localFile(main);
  }

  return {
    files,
    sources: PLACES.flatMap((place) => {
      const file = files[place];

      return file === undefined ? [] : [source(place, file, read)];
    }),
  };
};

/** Yours alone over core's defaults: your file on this Mac and, in `repo`, yours for it. */
export const yourOwnSettings = (places: SettingsPlaces, repo?: string): Settings =>
  mergeSettings(layerFiles(places, repo, readYamlFile).sources.filter((s) => s.place !== 'repo'))
    .values;

/**
 * The merged settings with what a GitHub board reads at `repo` filled into `board` (ADR 0025):
 * its repo from the main checkout's origin, as its git config's file says it (`text` reads it),
 * and the checkout's gh login.
 */
const withGithubBoard = (
  merged: Merged,
  repo: string | undefined,
  text: (file: string) => string | undefined,
): Merged => {
  const board = githubBoardFilled(merged.values.board, {
    origin: () =>
      repo === undefined
        ? undefined
        : originOfGitConfig(text(join(mainCheckout(repo) ?? repo, '.git', 'config'))),
    githubAccount: githubAccountOf(merged.values),
  });

  return board === merged.values.board
    ? merged
    : { ...merged, values: { ...merged.values, board } };
};

/** The settings in force for work in `repo` (a checkout's top folder, or none). */
export const loadSettings = (
  places: SettingsPlaces,
  repo: string | undefined,
  read: Read = readYamlFile,
): Merged => withGithubBoard(mergeSettings(layerFiles(places, repo, read).sources), repo, readText);

/** az's login folder in force at a checkout, and whose it is (`checkout`: yours for this repo). */
export type AzFolder =
  { from: 'environment' | 'checkout'; dir: string } | { from: 'none'; dir: null };

/**
 * az's login folder in force where `values` are: serve's own environment's `$AZURE_CONFIG_DIR`
 * (it overrides the settings), else yours for that repo, else none (az's own).
 */
const azureFolderIn = (
  environment: SettingsService['environment'],
  values: Pick<Settings, 'board'>,
): AzFolder => {
  const set = environment?.AZURE_CONFIG_DIR;

  if (set !== undefined && set !== '') return { from: 'environment', dir: set };
  const az = values.board.azureConfigDir;

  return az === undefined || az === ''
    ? { from: 'none', dir: null }
    : { from: 'checkout', dir: az };
};

/** az's login folder in force at `dir` (`azureFolderIn`). */
export const azureFolderAt = (
  settings: Pick<SettingsService, 'environment' | 'at'>,
  dir: string,
): AzFolder => azureFolderIn(settings.environment, settings.at(dir).values);

/**
 * What serve derives from the settings in force at a folder, once per checkout (ADR 0025, 0029,
 * 0030): every command asks the same, so none disagree.
 */
export type CheckoutFacts = {
  /** Your gh login there (`logins.gh`); null: gh's active one. */
  githubAccount: string | null;
  /** az's login folder there. */
  azFolder: AzFolder;
  /** `box.profile` there; null: none named. */
  boxProfile: string | null;
  /** The environments its agents reach (`agents.<env>`). */
  agentEnvs: readonly AbeEnv[];
  /** The checkout in local mode the folder is in (a card worktree counts as its checkout). */
  localMode: string | undefined;
  /** The checkouts your file on this Mac names (`checkoutsIn`). */
  yourCheckouts: readonly string[];
};

/** What a handler holds: where the files are, and the settings in force where it was asked. */
export type SettingsService = {
  places: SettingsPlaces;
  /**
   * serve's own environment as it was started, before the Layers filled your environment in
   * a personal key it sets is overridden, as `explain` says. None: nothing overrides.
   */
  environment?: Readonly<Record<string, string | undefined>>;
  /** The settings in force in `cwd`'s checkout; its files are watched from now on. */
  at: (cwd: string) => Merged;
  /** What serve derives from them there. */
  facts: (cwd: string) => CheckoutFacts;
  /** The facts of every checkout looked up so far (and of none). */
  seen: () => readonly Omit<CheckoutFacts, 'localMode'>[];
  /** Read the files now (the timer does every `every` ms): a write of serve's own calls it. */
  poll: () => void;
  stop: () => void;
};

const YourCheckouts = z.looseObject({
  localMode: z.array(z.string()).optional(),
  boardReadOnly: z.array(z.string()).optional(),
});

/**
 * The checkouts your file on this Mac (`doc`) names (ADR 0029, 0030): local mode's and the
 * read-only board's, from /. A session reads none of their Abe env files but its own checkout's
 * enabled ones.
 */
const checkoutsIn = (doc: unknown): string[] => {
  const read = YourCheckouts.safeParse(doc);
  const d = read.success ? read.data : {};

  return [...new Set([...(d.localMode ?? []), ...(d.boardReadOnly ?? [])])].filter((p) =>
    p.startsWith('/'),
  );
};

const changedKeys = (before: Settings, after: Settings): SettingKey[] =>
  settingKeys().filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));

/** Reads each file once and keeps its text, so a merge and what it is compared with agree. */
const once = () => {
  const texts = new Map<string, string | undefined>();
  const text = (file: string) => {
    if (!texts.has(file)) texts.set(file, readText(file));

    return texts.get(file);
  };
  const read: Read = (file) => {
    const t = text(file);

    return t === undefined ? { doc: undefined } : parseYaml(t);
  };

  return { texts, text, read };
};

/** At most this many folders are remembered with the checkout each is in. */
const FOLDERS_MAX = 512;

/** One checkout's settings as last merged, with what serve derives from them. */
type Snapshot = {
  merged: Merged;
  facts: Omit<CheckoutFacts, 'localMode'>;
  /** The main checkout its files were read from: one moved since (ADR 0037) is read again. */
  main: string | undefined;
};

/** What a merge gives serve beyond the values (ADR 0025, 0029, 0030). */
const factsOf = (
  merged: Merged,
  sources: readonly LayerSource[],
  environment: SettingsService['environment'],
): Snapshot['facts'] => {
  const machine = sources.find((s) => s.place === 'machine');

  return {
    githubAccount: githubAccountOf(merged.values),
    azFolder: azureFolderIn(environment, merged.values),
    boxProfile: merged.values['box.profile'],
    agentEnvs: ABE_ENVS.filter((e) => merged.values[agentEnvKey(e)]),
    yourCheckouts: checkoutsIn(machine !== undefined && 'doc' in machine ? machine.doc : undefined),
  };
};

/**
 * The settings service: one merged snapshot per checkout, made at its first lookup and made again
 * only when the poll finds one of its files changed. A lookup reads no file.
 * When a change moves a merged value, `emit`s the keys that moved, once per checkout.
 */
export const startSettings = (o: {
  places: SettingsPlaces;
  emit: (data: SettingsChangedData) => void;
  every: number;
  environment?: Readonly<Record<string, string | undefined>>;
}): SettingsService => {
  const snapshots = new Map<string | null, Snapshot>();
  /** Each folder asked about, and the checkout it is in (null: none). */
  const folders = new Map<string, string | null>();
  /** Each watched file's text as last merged. */
  let texts = new Map<string, string | undefined>();
  const build = (repo: string | null, read: ReturnType<typeof once>): Snapshot => {
    const { sources } = layerFiles(o.places, repo ?? undefined, read.read);
    const merged = withGithubBoard(mergeSettings(sources), repo ?? undefined, read.text);

    // a worktree reading its main checkout's abe.yaml is told when one of its own appears
    if (repo !== null) read.text(repoFile(repo));

    return {
      merged,
      facts: factsOf(merged, sources, o.environment),
      main: repo === null ? undefined : mainCheckout(repo),
    };
  };
  const checkoutAt = (cwd: string): string | null => {
    const known = folders.get(cwd);

    if (known !== undefined) return known;
    const found = repoRoot(cwd) ?? null;
    const oldest = folders.keys().next();

    if (folders.size >= FOLDERS_MAX && oldest.done !== true) folders.delete(oldest.value);
    folders.set(cwd, found);

    return found;
  };
  const snapshotOf = (repo: string | null): Snapshot => {
    const had = snapshots.get(repo);

    if (had !== undefined) return had;
    const read = once();
    const made = build(repo, read);

    snapshots.set(repo, made);
    // a file read now that changed since the last poll stays as that poll read it, so the next
    // one still tells the checkouts seen before
    for (const [file, text] of read.texts) if (!texts.has(file)) texts.set(file, text);

    return made;
  };
  const poll = () => {
    // a folder outside every checkout, or whose checkout is gone, is looked up again
    for (const [cwd, repo] of folders)
      if (repo === null || !existsSync(join(repo, '.git'))) folders.delete(cwd);
    const now = once();
    const moved = (repo: string | null, s: Snapshot) =>
      repo !== null && mainCheckout(repo) !== s.main;

    if (
      [...texts].every(([file, text]) => now.text(file) === text) &&
      ![...snapshots].some(([repo, s]) => moved(repo, s))
    )
      return;
    for (const [repo, before] of snapshots) {
      const after = build(repo, now);
      const keys = changedKeys(before.merged.values, after.merged.values);

      snapshots.set(repo, after);
      if (keys.length > 0) o.emit({ keys, repo });
    }
    texts = now.texts;
  };
  const at = (cwd: string) => snapshotOf(checkoutAt(cwd)).merged;
  const facts = (cwd: string): CheckoutFacts => {
    const snapshot = snapshotOf(checkoutAt(cwd));

    return {
      ...snapshot.facts,
      localMode: localCheckoutOf(snapshot.merged.values.localMode, cwd),
    };
  };

  snapshotOf(null);
  const timer = setInterval(poll, o.every);

  return {
    places: o.places,
    ...(o.environment === undefined ? {} : { environment: o.environment }),
    at,
    facts,
    seen: () => [...snapshots.values()].map((s) => s.facts),
    poll,
    stop: () => {
      clearInterval(timer);
    },
  };
};

/** A service over `sources` as given, read from no file (a test's, or a caller with its own). */
export const fixedSettings = (
  places: SettingsPlaces,
  sources: readonly LayerSource[],
): SettingsService => {
  const merged = mergeSettings([...sources]);
  const facts = factsOf(merged, sources, undefined);

  return {
    places,
    at: () => merged,
    facts: (cwd) => ({ ...facts, localMode: localCheckoutOf(merged.values.localMode, cwd) }),
    seen: () => [facts],
    poll: () => undefined,
    stop: () => undefined,
  };
};
