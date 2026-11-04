/**
 * What Abe ships and what a repo owns (ADR 0033, ADR 0034). The install copies Abe's workflows
 * and skills into the repo's `abe/` once, recording each file's hash in `abe/installed.json`, and
 * from then on one rule says what a session or the workflow loader sees, per file: a file Abe
 * keeps (`owner: 'abe'`) is always Abe's; a copied one is the repo's, and a copy the repo deleted
 * is gone (disabled), never Abe's again. A repo not installed yet sees Abe's. A newer Abe never
 * writes over the copies: its changes are an update, a three-way merge of Abe's text as copied
 * (the base), the repo's copy and Abe's text now, which moves the base when it is applied.
 *
 * The repo's folder is a port (`AbeFolder`): the ports read and write the disk and git, a test a
 * temporary folder.
 */
import { z } from 'zod';
import { SHIPPED_FILES, type ShippedFile } from './files';
import { merge3 } from './merge';

/** A file's path and text. */
export type ShippedText = { path: string; text: string };

/**
 * A repo's `abe/` folder, every path under it (`skills/tdd/SKILL.md`, `workflows/bug.yaml`,
 * `installed.json`).
 */
export type AbeFolder = {
  /** The file's text; null when it is not there. */
  read: (path: string) => string | null;
  /** Writes the file, its folders made. */
  write: (path: string, text: string) => void;
  /** Every file under `skills/` and `workflows/`. */
  files: () => readonly string[];
  /** A text's sha256, as `installed.json` keeps it. */
  hash: (text: string) => string;
  /** The file's committed texts, newest first: where an edited copy's base is found. */
  history: (path: string) => Promise<readonly string[]>;
};

/** The record of what the install copied, by its path under `abe/`. */
export const INSTALLED_RECORD = 'installed.json';

/** `abe/installed.json`: the Abe that last wrote the files, and each one's base as a hash. */
export const AbeInstalled = z.object({
  abe: z.string(),
  /** By path under `abe/` (`workflows/feature.yaml`, `skills/tdd/SKILL.md`): its sha256. */
  files: z.record(z.string(), z.string()),
});
export type AbeInstalled = z.infer<typeof AbeInstalled>;

const skillOf = (path: string): string | undefined => /^skills\/([^/]+)\//.exec(path)?.[1];

const SHIPPED_AT = new Map(SHIPPED_FILES.map((f) => [f.path, f]));

/** Abe's files the install copies: the repo's from then on. */
const COPIED: readonly ShippedFile[] = SHIPPED_FILES.filter((f) => f.owner === 'repo');

/**
 * The skills Abe keeps whole, never copied nor replaced by a repo's folder of that name: the Abe
 * chat's guide (`abe`), the run's driver (`factory`) and the install's skill, which say how this
 * Abe's own CLI works.
 */
export const ABE_ONLY_SKILLS: readonly string[] = [
  ...new Set(SHIPPED_FILES.flatMap((f) => skillOf(f.path) ?? [])),
].filter((name) => !COPIED.some((f) => skillOf(f.path) === name));

/** A path Abe keeps: one of its own files, or any file in a skill it keeps whole. */
const abeKeeps = (path: string): boolean =>
  SHIPPED_AT.get(path)?.owner === 'abe' || ABE_ONLY_SKILLS.includes(skillOf(path) ?? '');

/** Whether the repo has Abe's files: its `installed.json` or a skill under `abe/skills/`. */
export const isInstalled = (folder: AbeFolder | null): boolean =>
  folder !== null &&
  (folder.read(INSTALLED_RECORD) !== null || folder.files().some((p) => p.startsWith('skills/')));

/** The overlay rule for one of Abe's paths: Abe's file is in force while it keeps it or no copy is. */
const abeServes = (path: string, installed: boolean): boolean => !installed || abeKeeps(path);

/** The repo's own files a session or the loader reads: every one but those at a path Abe keeps. */
const repoFiles = (folder: AbeFolder | null): string[] =>
  folder === null ? [] : folder.files().filter((p) => !abeKeeps(p));

/**
 * Abe's own files in force for a repo (null: none, as outside a repo): all before the install,
 * after it only those Abe keeps. The workflow loader's built-in Layer.
 */
export const abeInForce = (folder: AbeFolder | null): ShippedFile[] => {
  const installed = isInstalled(folder);

  return SHIPPED_FILES.filter((f) => abeServes(f.path, installed));
};

/**
 * A session's plugin for a repo: `plugin`'s skill files where Abe's are in force, then each of the
 * repo's skill files under `abe/skills/` (a copy, or a skill only it has), so `/abe:<name>` runs
 * the repo's. Files outside a skill folder (the manifest, the agents) stay.
 */
export const pluginFor = <F extends ShippedText>(
  plugin: readonly F[],
  folder: AbeFolder | null,
): (F | ShippedText)[] => {
  const installed = isInstalled(folder);

  return [
    ...plugin.filter((f) => skillOf(f.path) === undefined || abeServes(f.path, installed)),
    ...repoFiles(folder)
      .filter((p) => p.startsWith('skills/'))
      .flatMap((path) => {
        const text = folder?.read(path) ?? null;

        return text === null ? [] : [{ path, text }];
      }),
  ];
};

const recordOf = (folder: AbeFolder): AbeInstalled | null => {
  const text = folder.read(INSTALLED_RECORD);

  if (text === null) return null;
  try {
    const read = AbeInstalled.safeParse(JSON.parse(text));

    return read.success ? read.data : null;
  } catch {
    return null;
  }
};

const writeRecord = (folder: AbeFolder, record: AbeInstalled): void => {
  folder.write(INSTALLED_RECORD, `${JSON.stringify(record, null, 2)}\n`);
};

/**
 * Abe's workflows and skills copied into the repo's `abe/` (each file only where none is), and
 * `installed.json` with each copied file's hash; nothing when the repo has them already (a
 * teammate's install). Answers how many workflows and skills it copied.
 */
export const copyInto = (
  folder: AbeFolder,
  version: string,
): { copied: boolean; workflows: number; skills: number } => {
  if (isInstalled(folder)) return { copied: false, workflows: 0, skills: 0 };
  for (const f of COPIED) if (folder.read(f.path) === null) folder.write(f.path, f.text);
  writeRecord(folder, {
    abe: version,
    files: Object.fromEntries(COPIED.map((f) => [f.path, folder.hash(f.text)])),
  });

  return {
    copied: true,
    workflows: COPIED.filter((f) => f.path.startsWith('workflows/')).length,
    skills: new Set(COPIED.flatMap((f) => skillOf(f.path) ?? [])).size,
  };
};

/** What a path under `abe/` is: a workflow by its id, a skill by its name. */
const ownerOf = (path: string): { kind: 'workflow' | 'skill'; name: string } => {
  const workflow = /^workflows\/([^/]+)\.yaml$/.exec(path)?.[1];

  return workflow === undefined
    ? { kind: 'skill', name: skillOf(path) ?? path }
    : { kind: 'workflow', name: workflow };
};

/** A workflow or skill a newer Abe changed (or added) since its base. */
export const AbeUpdate = z.object({
  kind: z.enum(['workflow', 'skill']),
  name: z.string(),
  /** Its files Abe changed, by path under `abe/`. */
  files: z.array(z.string()),
  /** Abe has it and the install never copied it. */
  added: z.boolean(),
  /** The repo changed its copy too: applying Abe's is a merge, not a copy. */
  edited: z.boolean(),
});
export type AbeUpdate = z.infer<typeof AbeUpdate>;

/**
 * What Abe changed since each file's base: none when the repo has no record (nothing copied, or
 * a record that does not read).
 */
export const updatesOf = (folder: AbeFolder): AbeUpdate[] => {
  const record = recordOf(folder);

  if (record === null) return [];
  const by = new Map<string, AbeUpdate>();

  for (const f of COPIED) {
    const was = record.files[f.path];

    if (was === folder.hash(f.text)) continue;
    const there = folder.read(f.path);
    const owner = ownerOf(f.path);
    const key = `${owner.kind}:${owner.name}`;
    const u = by.get(key) ?? { ...owner, files: [], added: true, edited: false };

    u.files.push(f.path);
    u.added = u.added && was === undefined;
    u.edited = u.edited || (was !== undefined && there !== null && folder.hash(there) !== was);
    by.set(key, u);
  }

  return [...by.values()];
};

/** `Abe 3.3.1 has newer feature, implement`: the Workflows part's note; '' for none. */
export const abeUpdatesWords = (version: string, updates: readonly AbeUpdate[]): string =>
  updates.length === 0
    ? ''
    : `Abe ${version} has newer ${updates.map((u) => u.name).join(', ')}: abe workflow update shows each three-way update, --write applies it`;

/** The Project tree's note on the repo's `abe/` folder; null when nothing is newer. */
export const updatesNotice = (version: string, updates: readonly AbeUpdate[]): string | null =>
  updates.length === 0 ? null : `Abe ${version} has newer ${updates.map((u) => u.name).join(', ')}`;

/**
 * How an update leaves one file: `new` Abe's added file written, `copy` an unedited copy
 * replaced by Abe's, `same` the copy is Abe's already, `deleted` the repo deleted its copy (it
 * stays deleted), `merged` the repo's edits and Abe's both kept, `conflict` both changed the same
 * lines (git's markers in `text`). Each moves the file's base to Abe's text when applied.
 */
export const UPDATE_HOWS = ['new', 'copy', 'same', 'deleted', 'merged', 'conflict'] as const;

export const UpdateFile = z.object({
  path: z.string(),
  kind: z.enum(['workflow', 'skill']),
  name: z.string(),
  how: z.enum(UPDATE_HOWS),
  conflicts: z.number().int().nonnegative(),
  /** What the file becomes; null when nothing is written (`same`, `deleted`). */
  text: z.string().nullable(),
});
export type UpdateFile = z.infer<typeof UpdateFile>;

/** The base of an edited copy: the committed text whose hash its record keeps; '' when none is. */
const baseOf = async (folder: AbeFolder, path: string, hash: string): Promise<string> =>
  (await folder.history(path)).find((t) => folder.hash(t) === hash) ?? '';

/**
 * Each update's files as the three-way update would leave them (only the `names` given, when
 * any): nothing written.
 */
export const proposeUpdates = async (
  folder: AbeFolder,
  version: string,
  names: readonly string[] = [],
): Promise<UpdateFile[]> => {
  const record = recordOf(folder);

  if (record === null) return [];
  const files = updatesOf(folder)
    .filter((u) => names.length === 0 || names.includes(u.name))
    .flatMap((u) => u.files.map((path) => ({ path, kind: u.kind, name: u.name })));

  return Promise.all(
    files.map(async (f): Promise<UpdateFile> => {
      const abe = SHIPPED_AT.get(f.path)?.text ?? '';
      const there = folder.read(f.path);
      const was = record.files[f.path];
      const as = (how: UpdateFile['how'], text: string | null, conflicts = 0): UpdateFile => ({
        ...f,
        how,
        conflicts,
        text,
      });

      if (there === null) return was === undefined ? as('new', abe) : as('deleted', null);
      if (there === abe) return as('same', null);
      if (was !== undefined && folder.hash(there) === was) return as('copy', abe);
      const base = was === undefined ? '' : await baseOf(folder, f.path, was);
      const merged = merge3(base, there, abe, {
        ours: "the repo's copy",
        base: 'Abe as copied',
        theirs: `Abe ${version}`,
      });

      return merged.conflicts === 0
        ? as('merged', merged.text)
        : as('conflict', merged.text, merged.conflicts);
    }),
  );
};

/**
 * Writes the update's files and moves each one's base in `installed.json` to Abe's text now, so
 * it is no longer newer, nor its copy read as edited when it is Abe's.
 */
export const applyUpdates = (
  folder: AbeFolder,
  version: string,
  files: readonly UpdateFile[],
): void => {
  const record = recordOf(folder);

  if (record === null || files.length === 0) return;
  const moved = { ...record.files };

  for (const f of files) {
    const abe = SHIPPED_AT.get(f.path)?.text;

    if (abe === undefined) continue;
    if (f.text !== null) folder.write(f.path, f.text);
    moved[f.path] = folder.hash(abe);
  }
  writeRecord(folder, { abe: version, files: moved });
};

/** `abe workflow update`: each newer file's three-way update, and whether it was written. */
export const WorkflowUpdateData = z.object({
  abe: z.string(),
  files: z.array(UpdateFile),
  written: z.boolean(),
});
export type WorkflowUpdateData = z.infer<typeof WorkflowUpdateData>;

const HOW_WORDS: Readonly<Record<UpdateFile['how'], string>> = {
  new: "Abe's new file",
  copy: "Abe's (the copy was never edited)",
  same: "the copy is Abe's already",
  deleted: 'deleted here: stays deleted',
  merged: "the repo's edits and Abe's merged",
  conflict: 'conflicts: resolve the markers',
};

export const workflowUpdateText = (d: WorkflowUpdateData): string =>
  d.files.length === 0
    ? `abe/ has Abe ${d.abe}'s files: nothing newer\n`
    : `${d.files
        .map((f) => `${f.path}  ${HOW_WORDS[f.how]}${f.conflicts > 1 ? ` (${f.conflicts})` : ''}\n`)
        .join(
          '',
        )}${d.written ? 'written, the base moved in abe/installed.json\n' : 'nothing written: --write applies it\n'}`;
