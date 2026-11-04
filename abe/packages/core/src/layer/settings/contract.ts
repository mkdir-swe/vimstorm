/** `abe settings`' results and the `settings.changed` event's data, as clients read them. */
import { z } from 'zod';
import { FEELS, LAYERS, PLACES, SettingKeyName, WRITABLE_LAYERS } from './keys';

export const LayerName = z.enum(LAYERS);

/** A setting's value: plain JSON. */
export const SettingValue = z.json();

/** What can be wrong with a layer file's entry (or the whole file, `bad-layer-file`). */
export const ProblemCode = z.enum([
  'override-required',
  /** A write Reach name of yours (ADR 0010, 0030): only the repo's file grants one. */
  'write-below-repo',
  'reason-required',
  'invalid-override',
  'unknown-setting',
  'invalid-setting',
  /** Yours alone, for this repo (ADR 0030): the repo's file never sets it. */
  'personal-only',
  /** The team's (ADR 0031): yours never sets it, only the repo's file. */
  'team-only',
  /** An editor preference or your environment (#344, ADR 0030): yours on this Mac, never a repo's file. */
  'not-in-repo',
  'duplicate-setting',
  'bad-layer-file',
  'unknown-node',
  /** `ui.theme` names no theme there is (#172): Islands Dark is drawn in its place. */
  'unknown-theme',
  /** `editor.scheme` names no theme there is (#345): the editor takes the theme's own colours. */
  'unknown-scheme',
  /** A write to prod granted by a Layer (ADR 0029): only you turn prod on, for this repo. */
  'prod-off',
]);
export type ProblemCode = z.infer<typeof ProblemCode>;

/** Something wrong in a layer file, named by file and key; `key` is `null` for the whole file. */
export const SettingProblem = z.object({
  code: ProblemCode,
  layer: LayerName,
  file: z.string(),
  key: z.string().nullable(),
  message: z.string(),
});
export type SettingProblem = z.infer<typeof SettingProblem>;

/** One Layer's part in a value: what its file writes and whether that took effect. */
export const LayerStep = z.object({
  layer: LayerName,
  file: z.string().nullable(),
  entry: z.enum(['plain', 'override']).nullable(),
  written: SettingValue.nullable(),
  reason: z.string().nullable(),
  /** An Override's since when (an ISO time, #168), when its file says. */
  since: z.string().optional(),
  applied: z.boolean(),
});
export type LayerStep = z.infer<typeof LayerStep>;

/** `abe settings get <key>`: the merged value; a refused entry is listed and the upper value kept. */
export const SettingGetData = z.object({
  key: z.string(),
  value: SettingValue,
  layer: LayerName,
  lowered: z.string().nullable(),
  problems: z.array(SettingProblem),
});
export type SettingGetData = z.infer<typeof SettingGetData>;

/** `abe settings explain <key>`: every Layer's value, the winner and an Override's reason. */
export const SettingExplainData = z.object({
  key: z.string(),
  value: SettingValue,
  winner: LayerName,
  lowered: z.string().nullable(),
  layers: z.array(LayerStep),
  /** The Feel in force: what the `feel` step names (#174). */
  feel: z.enum(FEELS),
  problems: z.array(SettingProblem),
  /** What the setting is: its summary; a board field set as a key of its own (`board.notTag`), its own. */
  about: z.string().optional(),
  /**
   * A variable of serve's environment that overrides the Layers (#344): `ABE_BOX_PROFILE` for
   * `box.profile`; `field` when it is one field of the value (`board`'s `azureConfigDir`);
   * `fallback` when it overrides nothing but stands where the Layers name none (`AWS_PROFILE`).
   */
  environment: z
    .object({
      name: z.string(),
      value: z.string(),
      field: z.string().optional(),
      fallback: z.boolean().optional(),
    })
    .optional(),
});
export type SettingExplainData = z.infer<typeof SettingExplainData>;

/** `abe settings set`: what was written where, and the merged value after (`written` differs where a Layer below wins, or a list adds). */
export const SettingSetData = z.object({
  key: z.string(),
  layer: z.enum(WRITABLE_LAYERS),
  /** Which file (ADR 0030): the repo's, yours on this Mac, or yours for this repo. */
  place: z.enum(PLACES),
  file: z.string(),
  entry: z.enum(['plain', 'override']),
  written: SettingValue,
  reason: z.string().nullable(),
  /** The value in force after the write, and the Layer it comes from (#173). */
  value: SettingValue,
  winner: LayerName,
  /** What else to know about the write: your environment's keys apply as serve starts (#344). */
  note: z.string().optional(),
});
export type SettingSetData = z.infer<typeof SettingSetData>;

/** `abe settings check <dir>`: the layer files checked, all clean (any problem exits 1). */
export const SettingsCheckData = z.object({ files: z.array(z.string()) });
export type SettingsCheckData = z.infer<typeof SettingsCheckData>;

/**
 * `settings.changed`: the keys whose merged value changed, for the repo it was merged in; or, from
 * `abe improve apply` / `undo`, the personal Layer's files written (`files`, keys empty).
 */
export const SettingsChangedData = z
  .object({
    keys: z.array(SettingKeyName),
    repo: z.string().nullable(),
    files: z.array(z.string()).min(1).optional(),
  })
  .refine((d) => d.keys.length > 0 || d.files !== undefined, {
    message: 'a change names its keys or its files',
  });
export type SettingsChangedData = z.infer<typeof SettingsChangedData>;
