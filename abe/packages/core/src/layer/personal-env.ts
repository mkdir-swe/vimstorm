/**
 * Your environment from the Layers (#344, #100): the AWS profile and region your boxes are reached
 * on, who owns them, the stores and your az folder are Layer keys, so VimStorm opened from the
 * Dock (launchd's bare environment) reaches them as a terminal does. A variable the environment
 * sets overrides its key; `abe settings explain` names it. Your Layer's `box.profile` beats a
 * shell's `$AWS_PROFILE` (a work profile exported there is never abe's): only `$ABE_BOX_PROFILE`
 * overrides it, and `$AWS_PROFILE` stands only where the Layers name none.
 */
import { type SettingExplainData } from './settings/contract';
import { type Settings } from './settings/keys';

/** A personal key: a setting, or `board`'s `azureConfigDir` field. */
export type PersonalEnvKey =
  | 'box.profile'
  | 'box.region'
  | 'box.owner'
  | 'stores.logs'
  | 'stores.org'
  | 'board.azureConfigDir';

/**
 * Each key and the variables that override it, the first set one winning; the Layers' value of a
 * key none of them sets is given to `sets` (over what `sets` held). `fallback`: variables that
 * stand only where the Layers name none (a shell's `$AWS_PROFILE`).
 */
export const PERSONAL_ENV: readonly {
  key: PersonalEnvKey;
  names: readonly string[];
  fallback?: readonly string[];
  sets: string;
}[] = [
  {
    key: 'box.profile',
    names: ['ABE_BOX_PROFILE'],
    fallback: ['AWS_PROFILE'],
    sets: 'AWS_PROFILE',
  },
  { key: 'box.region', names: ['AWS_REGION', 'AWS_DEFAULT_REGION'], sets: 'AWS_REGION' },
  { key: 'box.owner', names: ['ABE_OWNER'], sets: 'ABE_OWNER' },
  { key: 'stores.logs', names: ['ABE_LOG_STORE'], sets: 'ABE_LOG_STORE' },
  { key: 'stores.org', names: ['ABE_ORG_STORE'], sets: 'ABE_ORG_STORE' },
  { key: 'board.azureConfigDir', names: ['AZURE_CONFIG_DIR'], sets: 'AZURE_CONFIG_DIR' },
];

type Env = Readonly<Record<string, string | undefined>>;

/** Every variable a personal key reads, its overrides and fallbacks: what serve keeps as started. */
export const PERSONAL_ENV_NAMES: readonly string[] = PERSONAL_ENV.flatMap((p) => [
  ...p.names,
  ...(p.fallback ?? []),
]);

/** The first of `names` set (non-empty) in `env`, and its value. */
const firstSet = (
  names: readonly string[],
  env: Env,
): { name: string; value: string } | undefined => {
  for (const name of names) {
    const value = env[name];

    if (value !== undefined && value !== '') return { name, value };
  }

  return undefined;
};

/**
 * The variable that overrides `key` in `env`, and its value; none set (or only empty): undefined.
 * A `fallback` never overrides the Layers.
 */
export const fromEnvironment = (
  key: PersonalEnvKey,
  env: Env,
): { name: string; value: string } | undefined =>
  firstSet(PERSONAL_ENV.find((p) => p.key === key)?.names ?? [], env);

/** `~/x` as a path under `home`. */
const homed = (path: string, home: string) => {
  if (path === '~') return home;

  return path.startsWith('~/') ? `${home}${path.slice(1)}` : path;
};

/** The Layers' value of `key` (none: null). */
export const layerValueOf = (values: Settings, key: PersonalEnvKey): string | null => {
  if (key !== 'board.azureConfigDir') return values[key];
  const dir = values.board.azureConfigDir;

  return typeof dir === 'string' && dir !== '' ? dir : null;
};

/**
 * `env` with each key it leaves unset taken from the Layers' `values` (a folder's `~` under
 * `home`): a new environment, the one given untouched. `azureConfigDir`, when given, is yours
 * alone (your own Layer's), in place of the merged `board`'s. Its `$AWS_PROFILE` is the box
 * profile in force: `$ABE_BOX_PROFILE`, else the Layers', else the shell's own.
 */
export const withPersonalEnv = (
  env: Env,
  values: Settings,
  home: string,
  azureConfigDir?: string | null,
): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = { ...env };

  for (const p of PERSONAL_ENV) {
    const value =
      p.key === 'board.azureConfigDir' && azureConfigDir !== undefined
        ? azureConfigDir
        : layerValueOf(values, p.key);
    const set = fromEnvironment(p.key, env);

    if (value !== null && set === undefined)
      out[p.sets] = p.key === 'board.azureConfigDir' ? homed(value, home) : value;
    // `sets` a fallback (`$AWS_PROFILE`): it carries the override too, never the shell's beside it.
    else if (set !== undefined && p.fallback?.includes(p.sets) === true) out[p.sets] = set.value;
  }

  return out;
};

/**
 * `explain`'s answer with the variable that overrides the Layers where serve's own environment
 * (`env`, as it was started: before the Layers filled it) sets one: for a whole key its value is
 * in force, for `board`'s field the field is. Where the Layers name none, a `fallback` set there
 * is in force (`fallback: true`).
 */
export const explainedWithEnvironment = (d: SettingExplainData, env: Env): SettingExplainData => {
  if (d.key === 'board') {
    const set = fromEnvironment('board.azureConfigDir', env);
    const value =
      typeof d.value === 'object' && d.value !== null && !Array.isArray(d.value) ? d.value : {};

    return set === undefined
      ? d
      : {
          ...d,
          value: { ...value, azureConfigDir: set.value },
          environment: { ...set, field: 'azureConfigDir' },
        };
  }
  const p = PERSONAL_ENV.find((e) => e.key === d.key);

  if (p === undefined) return d;
  const set = fromEnvironment(p.key, env);

  if (set !== undefined) return { ...d, value: set.value, environment: set };
  const fallback = d.value === null ? firstSet(p.fallback ?? [], env) : undefined;

  return fallback === undefined
    ? d
    : { ...d, value: fallback.value, environment: { ...fallback, fallback: true } };
};

/** What `abe settings set` adds when it writes one of your environment's keys (#344). */
export const PERSONAL_ENV_NOTE =
  'your environment: abe serve reads it as it starts · abe serve stop applies it now';

/** Whether writing `value` to `key` changes your environment (`board` only by its azureConfigDir). */
export const writesPersonalEnv = (key: string, value: unknown): boolean =>
  key === 'board'
    ? typeof value === 'object' && value !== null && 'azureConfigDir' in value
    : PERSONAL_ENV.some((p) => p.key === key);
