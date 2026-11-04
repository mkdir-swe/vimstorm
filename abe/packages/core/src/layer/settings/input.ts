/**
 * What kind of input a setting takes, read from its value's schema: the dialog draws each row with
 * a control that fits it (a checkbox for a boolean, a pick for an enum, a list editor for an
 * array), never raw JSON for a known setting; only a value no plainer control can hold (an object,
 * a record, a list of objects) takes a records editor (`records.ts`), Advanced only where none fits. Also where a change of yours goes (the
 * row's scope) and the built-in value a row says as its default.
 */
import { z } from 'zod';
import { type SettingKey, SETTINGS, placesOf } from './keys';
import { type Control } from './pages';

/** The kinds of value a schema holds, as an input takes them. */
export const INPUTS = ['toggle', 'choice', 'number', 'text', 'list', 'object'] as const;
export type SettingInput = (typeof INPUTS)[number];

/** A schema with its wrappers (nullable, optional, default, catch, pipe) taken off. */
const bare = (schema: z.core.$ZodType): z.core.$ZodType => {
  if (
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodCatch
  )
    return bare(schema.def.innerType);
  if (schema instanceof z.ZodPipe) return bare(schema.def.in);

  return schema;
};

/** The input a schema takes: a union of a name and an object (a check, a login) is a name. */
export const schemaInput = (schema: z.core.$ZodType): SettingInput => {
  const s = bare(schema);

  if (s instanceof z.ZodBoolean) return 'toggle';
  if (s instanceof z.ZodEnum || s instanceof z.ZodLiteral) return 'choice';
  if (s instanceof z.ZodNumber) return 'number';
  if (s instanceof z.ZodString) return 'text';
  if (s instanceof z.ZodArray) return 'list';
  if (s instanceof z.ZodUnion) {
    const kinds = s.options.map(schemaInput);

    return kinds.includes('text') ? 'text' : (kinds[0] ?? 'object');
  }

  return 'object';
};

/** The schema of a setting, or of one field of an object setting (`board`'s `done`). */
const schemaOf = (key: SettingKey, field: string | null): z.core.$ZodType => {
  const schema: z.core.$ZodType = SETTINGS[key].schema;

  if (field === null) return schema;
  const s = bare(schema);

  if (!(s instanceof z.ZodObject)) return s;
  const shape: Readonly<Record<string, z.core.$ZodType>> = s.shape;

  return Object.entries(shape).find(([k]) => k === field)?.[1] ?? s;
};

/** No value is one a setting (or its field) takes: a nullable setting, an optional field. */
export const takesNone = (key: SettingKey, field: string | null = null): boolean => {
  const schema = schemaOf(key, field);

  return field === null
    ? z.safeParse(schema, null).success
    : schema instanceof z.ZodOptional || z.safeParse(schema, undefined).success;
};

/** The input a setting (or its field) takes, by its schema. */
export const inputOf = (key: SettingKey, field: string | null = null): SettingInput =>
  schemaInput(schemaOf(key, field));

/** The input a list setting's items take (`ports.fixed`: numbers), else `undefined`. */
export const itemInputOf = (
  key: SettingKey,
  field: string | null = null,
): SettingInput | undefined => {
  const s = bare(schemaOf(key, field));

  return s instanceof z.ZodArray ? schemaInput(s.element) : undefined;
};

/**
 * The controls an input may be drawn with: a pick of a few as segmented, a name the catalogue
 * knows the choices of (a model) as a combo, a list as chips, an object as Advanced.
 */
const FITS: Readonly<Record<SettingInput, readonly Control[]>> = {
  toggle: ['checkbox'],
  choice: ['combo', 'segmented'],
  number: ['number'],
  text: ['text', 'combo', 'path', 'secret', 'preview'],
  list: ['chips', 'table', 'records', 'advanced'],
  object: ['records', 'advanced', 'table'],
};

/** The catalogue's control fits what the setting's schema holds. */
export const controlFits = (control: Control, input: SettingInput): boolean =>
  FITS[input].includes(control);

/** Where a change of yours goes (the row's scope): the repo's, yours on this Mac, yours here. */
export const SETTING_SCOPES = ['repo', 'yours', 'local'] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

/**
 * A setting's scope: `repo` the team's file alone, `yours` on this Mac (an editor preference or
 * your environment), `local` yours for this repo (`.abe/settings.local.yaml`, over the repo's).
 */
export const scopeOfKey = (key: SettingKey): SettingScope => {
  const places = placesOf(key);

  if (places.includes('local')) return 'local';

  return places.includes('repo') ? 'repo' : 'yours';
};

/** A setting's built-in value (a field's of an object setting). */
export const defaultOf = (key: SettingKey, field: string | null = null): unknown => {
  const d: unknown = SETTINGS[key].default;

  if (field === null) return d;

  return typeof d === 'object' && d !== null && !Array.isArray(d)
    ? Object.entries(d).find(([k]) => k === field)?.[1]
    : undefined;
};
