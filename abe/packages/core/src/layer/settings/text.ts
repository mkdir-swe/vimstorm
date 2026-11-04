/** `abe settings`' human text. */
import {
  type SettingExplainData,
  type SettingGetData,
  type SettingProblem,
  type SettingSetData,
  type SettingsCheckData,
} from './contract';
import { FEEL_WORDS, type Place } from './keys';
import { proposeCommand } from './override';

/** A file by its place (ADR 0030), as a write says where it went. */
export const PLACE_WORDS: Readonly<Record<Place, string>> = {
  repo: 'the repo',
  machine: 'yours on this machine',
  local: 'yours for this repo',
};

const shown = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

const problemLines = (problems: readonly SettingProblem[]) =>
  problems.map((p) => `! ${p.code}: ${p.message}\n`).join('');

export const settingGetText = (d: SettingGetData): string =>
  `${shown(d.value)}\n${problemLines(d.problems)}`;

/** A Layer as explain names it: the Feel by its name, `feel vscode`; `yours` for yours. */
const layerWords = (layer: SettingExplainData['winner'], feel: SettingExplainData['feel']) => {
  if (layer === 'feel') return `feel ${feel}`;

  return layer === 'individual' ? 'yours' : layer;
};

/**
 * Your Override in force (#168): yours alone, so the proposal that would make it the repo's is
 * suggested, never required.
 */
const suggestion = (key: string, value: unknown, reason: string) =>
  `  yours only; for the repo: ${proposeCommand(key, value, reason)}\n`;

const suggestLine = (d: SettingExplainData): string => {
  const mine = d.layers.find(
    (l) => l.layer === 'individual' && l.entry === 'override' && l.applied,
  );

  return mine === undefined ? '' : suggestion(d.key, mine.written, mine.reason ?? '');
};

/** The environment's row (#344): the variable that overrides the Layers (or stands where they name none), and its value. */
const environmentRow = (d: SettingExplainData, width: number): string => {
  const e = d.environment;

  if (e === undefined) return '';
  const what = e.field === undefined ? e.value : `${e.field}: ${e.value}`;

  const why = e.fallback === true ? 'the Layers name none' : 'overrides the Layers';

  return `  ${'environment'.padEnd(width)}  ${what}  ($${e.name} ${why})\n`;
};

export const settingExplainText = (d: SettingExplainData): string => {
  const width = Math.max(
    ...d.layers.map((l) => layerWords(l.layer, d.feel).length),
    d.environment === undefined ? 0 : 'environment'.length,
  );
  const rows = d.layers.map((l) => {
    const what = l.entry === null ? '-' : shown(l.written);
    const note = [
      l.entry === 'override'
        ? `override: ${l.reason ?? ''}${l.since === undefined ? '' : ` · since ${l.since.slice(0, 10)}`}`
        : '',
      l.entry !== null && !l.applied ? 'refused' : '',
      l.file ?? '',
    ]
      .filter((s) => s !== '')
      .join('  ');

    return `  ${layerWords(l.layer, d.feel).padEnd(width)}  ${what}${note === '' ? '' : `  (${note})`}\n`;
  });

  const env = d.environment;
  const layer = d.winner === 'feel' ? `Feel ${FEEL_WORDS[d.feel]}` : layerWords(d.winner, d.feel);
  const from = env !== undefined && env.field === undefined ? `environment ($${env.name})` : layer;

  return [
    `${d.key} = ${shown(d.value)}  from ${from}\n`,
    d.about === undefined ? '' : `  ${d.about}\n`,
    d.lowered === null ? '' : `  ${d.lowered}\n`,
    ...rows,
    environmentRow(d, width),
    suggestLine(d),
    problemLines(d.problems),
  ].join('');
};

/**
 * `<key> set in <layer> (<file>): <written>`, then the value in force where it differs (#173): a
 * Layer below winning, or a list the entry added to; your Override suggests proposing it (#168).
 */
export const settingSetText = (d: SettingSetData): string => {
  const wrote = `${d.key} ${d.entry === 'override' ? 'overridden' : 'set'} in ${PLACE_WORDS[d.place]} (${d.file}): ${shown(d.written)}\n${d.note === undefined ? '' : `${d.note}\n`}`;
  const suggest =
    d.layer === 'individual' && d.entry === 'override' && d.reason !== null
      ? suggestion(d.key, d.written, d.reason)
      : '';

  if (JSON.stringify(d.written) === JSON.stringify(d.value)) return `${wrote}${suggest}`;
  const from =
    d.winner === d.layer ? 'with the Layers above' : `from ${layerWords(d.winner, 'vimstorm')}`;

  return `${wrote}in force: ${shown(d.value)} (${from})\n${suggest}`;
};

/** `abe settings unset`: the entry out of its file, then the value in force there. */
export const settingUnsetText = (d: SettingSetData): string =>
  `${d.key} unset in ${PLACE_WORDS[d.place]} (${d.file})\nin force: ${shown(d.value)} (from ${layerWords(d.winner, 'vimstorm')})\n`;

export const settingsCheckText = (d: SettingsCheckData): string =>
  `${d.files.length} settings file${d.files.length === 1 ? '' : 's'} clean\n`;

/** `abe settings check`'s refusal: one line per problem, file, key and what is wrong. */
export const problemList = (problems: readonly SettingProblem[]): string =>
  problems.map((p) => `${p.file}: ${p.key ?? '(file)'}: ${p.code}: ${p.message}`).join('\n');
