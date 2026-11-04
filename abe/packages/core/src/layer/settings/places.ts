/**
 * Where each settings file sits (ADR 0030), and which files `abe settings check` reads: the
 * layout as plain path rules, so `ports` (finding) and `serve` (reading) agree.
 */
import { type Place } from './keys';

/** Yours on this Mac is named this. */
export const LAYER_FILE = 'settings.yaml';
/** Yours for this repo, beside the repo's: never tracked (Abe's `info/exclude` block). */
export const LOCAL_FILE = 'settings.local.yaml';
/** Yours for this repo, from the checkout's top, as an exclude line names it. */
export const LOCAL_PATH = `.abe/${LOCAL_FILE}`;
/** Your card workflows beside the repo's (`<id>.local.yaml`): never tracked, as an exclude line names them. */
export const LOCAL_WORKFLOWS = '.abe/workflows/*.local.yaml';
/** Yours in a repo's checkout, each kept out of git by Abe's `info/exclude` block. */
export const YOURS_IN_REPO: readonly string[] = [LOCAL_PATH, LOCAL_WORKFLOWS];

const join = (...parts: string[]) => parts.join('/').replace(/\/{2,}/g, '/');

/**
 * The team's settings file from the checkout's top (ADR 0031): `abe.yaml`, the repo's board,
 * checks, environments and `sources:`. The one place its path is said: every reader and writer
 * takes it from here (`repoFile`). Abe never commits it nor keeps it out of git.
 */
export const REPO_PATH = 'abe.yaml';
/** The team's settings file in a checkout (`REPO_PATH`). */
export const repoFile = (repo: string): string => join(repo, REPO_PATH);
/** Abe's local folder in a checkout: yours alone, always kept out of git (ADR 0031). */
export const LOCAL_DIR = '.abe/';
/**
 * Abe's folder in the repo (ADR 0033): the workflows and skills the install copied in from Abe,
 * the repo's from then on, with the team's own workflows beside them. Ordinary files like
 * `abe.yaml`: Abe never commits them nor keeps them out of git.
 */
export const REPO_ABE_DIR = 'abe';
/**
 * The team's card workflows: one file each, `abe/workflows/<id>.yaml` from the checkout's top
 * (the id is the file's name). Yours stay `.abe/workflows/<id>.local.yaml` (`LOCAL_WORKFLOWS`).
 */
export const REPO_WORKFLOWS_DIR = 'abe/workflows';
/**
 * Abe's skills as the repo has them: `abe/skills/<name>/`, loaded as the `abe` plugin
 * (`/abe:<name>`); the repo's own Claude Code skills stay in `.claude/skills/`.
 */
export const REPO_ABE_SKILLS_DIR = 'abe/skills';
/**
 * What the install copied from Abe, `abe/installed.json`: the Abe version and each file's hash as
 * copied, so a newer Abe's changed files are said, never written over the repo's.
 */
export const ABE_INSTALLED_FILE = 'abe/installed.json';
/** The team's workflows' folder in a checkout (`REPO_WORKFLOWS_DIR`). */
export const repoWorkflowsDir = (repo: string): string => join(repo, REPO_WORKFLOWS_DIR);
/** The team's workflow `id` in a checkout: `abe/workflows/<id>.yaml`. */
export const repoWorkflowFile = (repo: string, id: string): string =>
  join(repo, REPO_WORKFLOWS_DIR, `${id}.yaml`);
/** `.abe/settings.local.yaml` in a (main) checkout. */
export const localFile = (repo: string): string => join(repo, '.abe', LOCAL_FILE);

/** The header of a new `.abe/settings.local.yaml`. */
export const LOCAL_HEADER = [
  '# Yours for this repo (ADR 0030): your own values over abe.yaml.',
  '# Never committed: Abe keeps it in .git/info/exclude.',
  '',
].join('\n');
/** `settings.yaml` in your Abe config folder: yours on this Mac. */
export const individualFile = (configDir: string): string => join(configDir, LAYER_FILE);

/** The place a file is, by its name: `abe.yaml` the team's, `.abe/settings.local.yaml` yours for the repo, any other yours on this Mac. */
export const placeOfFile = (file: string): Place => {
  const parts = file.split('/');

  if (parts.at(-1) === REPO_PATH) return 'repo';

  return parts.at(-2) === '.abe' && parts.at(-1) === LOCAL_FILE ? 'local' : 'machine';
};

/** The settings files found in a folder. */
export type FoundFiles = {
  /** `<dir>/settings.yaml`. */
  top: string | undefined;
  /** `<dir>/abe.yaml`. */
  repo: string | undefined;
  /** `<dir>/.abe/settings.local.yaml`. */
  local: string | undefined;
};

/** One file to check, as its place says; it is merged alone over core. */
export type CheckStep = { file: string; place: Place };

/** Each file found, checked alone over core's defaults as the place it sits in. */
export const checkPlan = (found: FoundFiles): CheckStep[] =>
  [found.top, found.repo, found.local]
    .filter((f) => f !== undefined)
    .map((file) => ({ file, place: placeOfFile(file) }));

/** The folder of theme files (`themes/<slug>.json`, #108). */
export const THEMES_DIR = 'themes';
/** Your theme files: `<config>/themes/`. */
export const yourThemesDir = (configDir: string): string => join(configDir, THEMES_DIR);
/** A theme file's name in its folder. */
export const themeFileName = (slug: string): string => `${slug}.json`;

/** The repo's settings file, from its root: what `abe settings propose` changes. */
export const PROPOSAL_PATH = REPO_PATH;

/**
 * A proposal's branch, one per thing proposed so a second proposal of it updates the same pull
 * request: `settings/repo/<name>`. `name` is a setting key, `<key>.<field>` for one field.
 */
export const proposalBranch = (name: string): string => `settings/repo/${name}`;

/** The branches the repo's proposals sit on start with this. */
export const PROPOSAL_PREFIX = proposalBranch('');
