/**
 * `board`'s fields set as keys of their own: your az folder (`board.azureConfigDir`, yours alone),
 * the team's area and tag (`board.area`, `board.tag`), and the lanes and tag a repo leaves out
 * (`board.excludeLanes`, `board.notTag`).
 */
import { z } from 'zod';
import { type SettingExplainData } from './contract';

/** Your az folder, `board`'s field set as a key of its own (yours alone). */
export const isAzureFolderField = (key: string): key is 'board.azureConfigDir' =>
  key === 'board.azureConfigDir';

/** `board`'s team fields set as keys of their own (`abe settings set board.area <path> --repo`). */
export const BOARD_FIELDS = [
  'board.area',
  'board.tag',
  'board.excludeLanes',
  'board.notTag',
] as const;
export type BoardField = (typeof BOARD_FIELDS)[number];

export const isBoardField = (key: string): key is BoardField => BOARD_FIELDS.some((k) => k === key);

const Name = z.string().trim().min(1);
const Names = z.union([Name, z.array(Name).min(1)]);

/** A board field's own value as typed: an area path or a lane (or a list of them), a tag. */
export const BoardFieldValue: Readonly<Record<BoardField, z.ZodType>> = {
  'board.area': Names,
  'board.tag': Name,
  'board.excludeLanes': Names,
  'board.notTag': Name,
};

/** What a board field takes, said when a value is refused. */
export const BOARD_FIELD_TAKES: Readonly<Record<BoardField, string>> = {
  'board.area': 'an area path, or a list of them',
  'board.tag': 'a tag',
  'board.excludeLanes': 'a swimlane, or a list of them',
  'board.notTag': 'a tag',
};

/** What each of `board`'s fields set as a key of its own is: `abe settings explain` says it. */
export const BOARD_FIELD_ABOUT: Readonly<Record<BoardField | 'board.azureConfigDir', string>> = {
  'board.area':
    "which cards of a shared board are this repo's: those under this area path (and the areas under it), or under any of a list",
  'board.tag': "which cards of a shared board are this repo's: those carrying this tag",
  'board.excludeLanes':
    "the board's swimlanes whose cards this repo leaves out of every list (card list, triage, the Board, what changed), as excludeLanes: [External dependencies]: cards waiting on others, no agent's to take. A card's lane is its System.BoardLane, set by the board of the team that owns the card's area path; a card in the default lane has none and stays",
  'board.notTag':
    'a tag whose cards this repo leaves out of every list (card list, triage, the Board, what changed), and the GitHub issues labelled so out of triage',
  'board.azureConfigDir':
    "your az's login folder ($AZURE_CONFIG_DIR overrides it): the board's cards are read with that login; yours alone, never the repo's",
};

const Doc = z.record(z.string(), z.json());
type Doc = z.infer<typeof Doc>;

const isDoc = (v: unknown): v is Doc => Doc.safeParse(v).success && !Array.isArray(v);

/** One field of a `board` value; null: it has none. */
const fieldOf = (v: unknown, name: string) => (isDoc(v) ? (v[name] ?? null) : null);

/**
 * `explain board`, read as one of its fields set as a key of its own: that field's value, each
 * Layer's step for it, and what the field is (`about`). Your az folder only from yours: it is
 * yours alone.
 */
export const boardFieldExplain = (
  board: SettingExplainData,
  key: BoardField | 'board.azureConfigDir',
): SettingExplainData => {
  const { environment, ...rest } = board;
  const name = key.slice('board.'.length);
  // a variable of serve's that sets this very field ($AZURE_CONFIG_DIR, the az folder's)
  const own = environment?.field === name ? environment : undefined;
  const layers = board.layers
    .filter((l) => !isAzureFolderField(key) || l.layer === 'individual')
    .map((l) => {
      const written = fieldOf(l.written, name);

      return {
        ...l,
        entry: written === null ? null : l.entry,
        written,
        applied: written !== null && l.applied,
      };
    });

  return {
    ...rest,
    key,
    value: fieldOf(board.value, name),
    winner: layers.findLast((l) => l.applied)?.layer ?? 'core',
    lowered: null,
    layers,
    problems: board.problems.filter((p) => p.key === 'board'),
    about: BOARD_FIELD_ABOUT[key],
    ...(own === undefined ? {} : { environment: { name: own.name, value: own.value } }),
  };
};

/** `explain board`, read as `board.azureConfigDir` alone: yours, never the repo's. */
export const azureFolderExplain = (board: SettingExplainData): SettingExplainData =>
  boardFieldExplain(board, 'board.azureConfigDir');
