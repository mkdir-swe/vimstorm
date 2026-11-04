/**
 * The merge: each file read into entries, then applied top to bottom over core's defaults (ADR
 * 0030: the repo's `abe.yaml`, then yours). A plain entry adds to the value above; an
 * Override lowers it, with its reason shown; a change that needs an Override and has none is
 * refused and the value above stays in force.
 */
import { z } from 'zod';
import {
  type Layer,
  layerIndex,
  layerOfPlace,
  type Place,
  placesOf,
  type SettingDef,
  type SettingKey,
  settingKeys,
  SETTINGS,
  type Settings,
  SettingsSchema,
  isMineSetting,
  isTeamSetting,
  isSettingKey,
  type WritableLayer,
  type Feel,
  FEEL_WORDS,
} from './keys';
import { type LayerStep, type ProblemCode, type SettingProblem } from './contract';
import { feelStart } from './feel';
import { loweredText, readOverride } from './override';

/**
 * One settings file as the ports read it, by its place (ADR 0030): its parsed YAML (`undefined`
 * when the file is missing or empty), or why it could not be parsed.
 */
export type LayerSource = { place: Place; file: string } & ({ doc: unknown } | { error: string });

export type Entry =
  | { kind: 'plain'; value: unknown }
  /** `since`: when it was written (#168), when the file says. */
  | { kind: 'override'; value: unknown; reason: string; since?: string | undefined };

export type ReadLayer = {
  place: Place;
  layer: WritableLayer;
  file: string;
  entries: Partial<Record<SettingKey, Entry>>;
  problems: SettingProblem[];
};

/** The key that holds a file's Overrides. */
export const OVERRIDES = 'overrides';

const Doc = z.record(z.string(), z.unknown());
type Doc = z.infer<typeof Doc>;

const isDoc = (v: unknown): v is Doc => Doc.safeParse(v).success && !Array.isArray(v);

/** Whether some setting lives under `prefix.` (so a map there is a group, not a value). */
const groups = (prefix: string) => settingKeys().some((k) => k.startsWith(`${prefix}.`));

const wide = (key: SettingKey): SettingDef<unknown> => SETTINGS[key];

const shown = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

const describe = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');

/** A file's entries and what is wrong in it. Unknown, invalid and reason-less entries are dropped. */
export const readLayer = (src: LayerSource): ReadLayer => {
  const { place, file } = src;
  const layer = layerOfPlace(place);
  const entries: Partial<Record<SettingKey, Entry>> = {};
  const problems: SettingProblem[] = [];
  const problem = (code: ProblemCode, key: string | null, message: string) => {
    problems.push({ code, layer, file, key, message });
  };
  /** The value the entry is read as, or `undefined` when it is dropped. */
  const valid = (key: SettingKey, value: unknown): { value: unknown } | undefined => {
    const d = wide(key);
    const checked = d.schema.safeParse(value);

    if (!checked.success) {
      const safe = d.safe;
      // A safe reading names what the file holds and what it is read as (problems: "names …").
      const message =
        safe === undefined
          ? describe(checked.error)
          : `${shown(value)}, read as ${shown(safe.value)} (${safe.why}): ${checked.error.issues.map((i) => i.message).join('; ')}`;

      problem('invalid-setting', key, message);

      return safe === undefined ? undefined : { value: safe.value };
    }
    const refused = d.check?.(checked.data);

    if (refused !== undefined) problem(refused.code, key, refused.message);

    return refused === undefined ? { value } : undefined;
  };
  /**
   * Whether the key is read from this file (ADR 0030). A factory setting in yours on this Mac is
   * skipped, never read, no problem.
   */
  const here = (key: SettingKey): boolean => {
    if (placesOf(key).includes(place)) return true;
    if (place === 'machine') return false;
    if (placesOf(key).includes('machine'))
      problem(
        'not-in-repo',
        key,
        `${key} is yours on this machine (Settings, or abe settings set ${key} <value>): a repo's files never set it`,
      );
    else if (isMineSetting(key))
      problem(
        'personal-only',
        key,
        `${key} is yours alone: ${wide(key).onlyWhy ?? `set it in .abe/settings.local.yaml (abe settings set ${key} <value> --mine)`}`,
      );
    else if (isTeamSetting(key))
      problem(
        'team-only',
        key,
        `${key} is the team's: ${wide(key).onlyWhy ?? `set it in the repo's abe.yaml (abe settings set ${key} <value> --repo)`}`,
      );

    return false;
  };
  const plain = (path: string, value: unknown) => {
    // a key read elsewhere whose fields are settings here: yours' `logins: { gh, az }` (ADR 0031)
    if (isSettingKey(path) && !placesOf(path).includes(place) && isDoc(value) && groups(path)) {
      for (const [k, v] of Object.entries(value)) plain(`${path}.${k}`, v);

      return;
    }
    if (isSettingKey(path)) {
      if (entries[path] !== undefined)
        problem('duplicate-setting', path, `${path} is written twice; the last one is used`);
      const read = here(path) ? valid(path, value) : undefined;

      if (read !== undefined) entries[path] = { kind: 'plain', value: read.value };
    } else if (isDoc(value) && groups(path)) {
      for (const [k, v] of Object.entries(value)) plain(`${path}.${k}`, v);
    } else problem('unknown-setting', path, `${path} is not a setting`);
  };

  if ('error' in src) {
    problem('bad-layer-file', null, src.error);

    return { place, layer, file, entries, problems };
  }
  if (src.doc === undefined || src.doc === null) return { place, layer, file, entries, problems };
  if (!isDoc(src.doc)) {
    problem('bad-layer-file', null, 'a layer file is a map of settings');

    return { place, layer, file, entries, problems };
  }
  const { [OVERRIDES]: overrides, ...rest } = src.doc;

  for (const [k, v] of Object.entries(rest)) plain(k, v);
  /** board's azureConfigDir is your own az folder: the repo's is dropped, said. */
  const yoursAlone = () => {
    const board = entries.board;

    if (layer === 'individual' || board === undefined || !isDoc(board.value)) return;
    if (board.value.azureConfigDir === undefined) return;
    problem(
      'personal-only',
      'board',
      'board.azureConfigDir is yours alone: set it in .abe/settings.local.yaml (abe settings set board.azureConfigDir <dir>)',
    );
    entries.board = {
      ...board,
      value: Object.fromEntries(
        Object.entries(board.value).filter(([k]) => k !== 'azureConfigDir'),
      ),
    };
  };
  const done = (): ReadLayer => {
    yoursAlone();

    return { place, layer, file, entries, problems };
  };

  if (overrides === undefined) return done();
  if (!isDoc(overrides)) {
    problem('invalid-override', null, 'overrides is a map of key → { value, reason }');

    return done();
  }
  for (const [key, raw] of Object.entries(overrides)) {
    if (!isSettingKey(key)) {
      problem('unknown-setting', key, `${key} is not a setting`);
      continue;
    }
    const read = readOverride(raw, key);

    if (!read.ok) {
      problem(read.code, key, read.message);
      continue;
    }
    const value = here(key) ? valid(key, read.value) : undefined;

    if (value !== undefined) {
      if (entries[key] !== undefined)
        problem('duplicate-setting', key, `${key} is set and overridden; the Override is used`);
      entries[key] = {
        kind: 'override',
        value: value.value,
        reason: read.reason,
        ...(read.since === null ? {} : { since: read.since }),
      };
    }
  }

  return done();
};

export type Explained = {
  key: SettingKey;
  value: unknown;
  /** The last Layer whose entry took effect. */
  winner: Layer;
  /** `overridden by <layer>: <reason> · since <date>` for the last Override applied. */
  lowered: string | null;
  layers: LayerStep[];
  /** The Feel in force: the `feel` step's name. */
  feel: Feel;
  /** This key's problems, and those of any file whose entries were all dropped. */
  problems: SettingProblem[];
};

export type Merged = {
  values: Settings;
  /** Every problem of every file, and every entry refused for want of an Override. */
  problems: SettingProblem[];
  explain: (key: SettingKey) => Explained;
  /** The same Layers merged without `layer`'s files: what the repo gives above yours (#108). */
  without: (layer: WritableLayer) => Merged;
};

const json = (v: unknown): LayerStep['written'] => {
  const checked = z.json().safeParse(v);

  return checked.success ? checked.data : String(v);
};

type Walk = {
  value: unknown;
  winner: Layer;
  lowered: string | null;
  layers: LayerStep[];
  feel: Feel;
};

/** Whose value stays in force, as a refusal says it: `the repo value`, `the Feel VS Code value`. */
const heldWords = (walk: Walk): string => {
  switch (walk.winner) {
    case 'core':
      return 'the built-in value';
    case 'feel':
      return `the Feel ${FEEL_WORDS[walk.feel]} value`;
    case 'repo':
      return 'the repo value';
    case 'individual':
      return 'your value';
  }
};

const apply = (
  key: SettingKey,
  walk: Walk,
  read: ReadLayer | undefined,
  layer: Layer,
): SettingProblem | undefined => {
  const d = wide(key);
  const entry = read?.entries[key];
  const step: LayerStep = {
    layer,
    file: read?.file ?? null,
    entry: entry?.kind ?? null,
    written: entry === undefined ? null : json(entry.value),
    reason: entry?.kind === 'override' ? entry.reason : null,
    ...(entry?.kind === 'override' && entry.since !== undefined ? { since: entry.since } : {}),
    applied: false,
  };

  walk.layers.push(step);
  if (entry === undefined || read === undefined) return undefined;
  // a value no Layer gives, an Override neither (ADR 0029: prod is turned on by you alone)
  const never = d.never?.(entry.value);

  if (never !== undefined) {
    const message = `${read.file}: ${key} ${never}; ${heldWords(walk)} stays in force`;

    return { code: 'prod-off', layer, file: read.file, key, message };
  }
  if (entry.kind === 'override') {
    const refused = d.overrideGuard?.(layer, entry.value);

    if (refused !== undefined) {
      const message = `${read.file}: ${key} ${refused}; ${heldWords(walk)} stays in force`;

      return { code: 'write-below-repo', layer, file: read.file, key, message };
    }
    walk.value = (d.lower ?? ((_: unknown, w: unknown) => w))(walk.value, entry.value);
    walk.winner = layer;
    walk.lowered = loweredText(layer, entry.reason, entry.since ?? null);
    step.applied = true;

    return undefined;
  }
  const next = d.add(walk.value, entry.value);
  const guard = d.guard;
  const why =
    guard !== undefined && layerIndex(layer) >= layerIndex(guard.from)
      ? guard.needs(walk.value, next, entry.value)
      : undefined;

  if (why !== undefined) {
    // An Override here would be refused too (a write Reach of yours): say so.
    const neither = d.overrideGuard?.(layer, next);
    const also =
      neither === undefined ? '' : `; an Override here is refused too: ${key} ${neither}`;
    const message = `${read.file}: ${key} ${why} without an Override${also}; ${heldWords(walk)} stays in force`;

    // refused either way (a write Reach of yours): no Override would do
    return {
      code: neither === undefined ? 'override-required' : 'write-below-repo',
      layer,
      file: read.file,
      key,
      message,
    };
  }
  walk.value = next;
  walk.winner = layer;
  step.applied = true;

  return undefined;
};

const walkKey = (
  key: SettingKey,
  reads: ReadonlyMap<Place, ReadLayer>,
  fileProblems: readonly SettingProblem[],
  feel: Feel,
): { explained: Explained; refused: SettingProblem[] } => {
  const core = wide(key).default;
  // the Feel's value where it sets the key (#121), a step of its own where it is not core's (#174)
  const value = feelStart(feel, key, core);
  const step = (layer: 'core' | 'feel', v: unknown): LayerStep => ({
    layer,
    file: null,
    entry: 'plain',
    written: json(v),
    reason: null,
    applied: true,
  });
  const byFeel = JSON.stringify(value) !== JSON.stringify(core);
  const walk: Walk = {
    value,
    winner: byFeel ? 'feel' : 'core',
    lowered: null,
    layers: byFeel ? [step('core', core), step('feel', value)] : [step('core', core)],
    feel,
  };
  const refused: SettingProblem[] = [];

  // only the files the key is read from (ADR 0030), in its order: a step each, file or none
  for (const place of placesOf(key)) {
    const problem = apply(key, walk, reads.get(place), layerOfPlace(place));

    if (problem !== undefined) refused.push(problem);
  }
  const own = fileProblems.filter((p) => p.key === key || p.key === null);

  return { explained: { key, ...walk, problems: [...own, ...refused] }, refused };
};

/**
 * Core's defaults with each file applied in order. `sources` holds the files located (missing
 * ones as `doc: undefined`); any order, at most one per place.
 */
export const mergeSettings = (sources: readonly LayerSource[]): Merged => mergeWith(sources);

/**
 * The merge, with `kept` as the Feel when given: `without` keeps the whole merge's Feel, so what a
 * Layer differs from is what removing its entry gives (your Feel still sets the switches).
 */
const mergeWith = (sources: readonly LayerSource[], kept?: Feel): Merged => {
  const reads = new Map<Place, ReadLayer>(sources.map((s) => [s.place, readLayer(s)]));
  const fileProblems = [...reads.values()].flatMap((r) => r.problems);
  // The Feel first: it says where every other key starts (the walk's value is already valid:
  // readLayer dropped a bad entry, so this parse only narrows the type).
  const feel =
    kept ??
    SettingsSchema.shape['ui.feel'].parse(
      walkKey('ui.feel', reads, fileProblems, 'vimstorm').explained.value,
    );
  const walks = settingKeys().map((key) => walkKey(key, reads, fileProblems, feel));

  return {
    values: SettingsSchema.parse(
      Object.fromEntries(walks.map(({ explained: e }) => [e.key, e.value])),
    ),
    problems: [...fileProblems, ...walks.flatMap((w) => w.refused)],
    explain: (key) => walkKey(key, reads, fileProblems, feel).explained,
    without: (layer) =>
      mergeWith(
        sources.filter((s) => layerOfPlace(s.place) !== layer),
        feel,
      ),
  };
};
