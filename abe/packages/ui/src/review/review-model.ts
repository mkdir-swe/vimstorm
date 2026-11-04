/**
 * The PR review's files pane, as rules (1.x's `changes/model.rs` and `screen.rs`): each file of the
 * scope (all changes, one commit, a range) as a row with its heat (1 for a mechanical change or a
 * copy, else none: size orders the rest), the areas hottest first, the groups the prepass folds
 * routine files into; the listing (a folder tree, the areas, every file by heat), its folds and
 * cursor, and where ⏎ / ⇧⏎ / `n` / `p` go. Pure, over `abe review show`'s read.
 */
import type { Marks, ReadCommit, ReviewRead } from '@abe/core';

export type FileStatus = 'A' | 'M' | 'D' | 'R';
export type Category =
  'copy' | 'imports' | 'rename' | 'format' | 'lockfile' | 'generated' | 'snapshot' | 'build';

const CATEGORIES: readonly Category[] = [
  'copy',
  'imports',
  'rename',
  'format',
  'lockfile',
  'generated',
  'snapshot',
  'build',
];

const CATEGORY_LABEL: Readonly<Record<Category, string>> = {
  copy: 'copy',
  imports: 'imports',
  rename: 'rename',
  format: 'format',
  lockfile: 'lockfile',
  generated: 'generated',
  snapshot: 'snapshot',
  build: 'build output',
};

/** Byte order, as 1.x sorted. */
const byBytes = (a: string, b: string): number => {
  if (a < b) return -1;

  return a > b ? 1 : 0;
};

/** A file as the pane shows it, its counts and changes those of the scope. */
export type FileRow = {
  /** Its path in the PR's diff. */
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** The heat it shows: 1 for a mechanical change or a copy; none else (size orders them). */
  score: number | null;
  /** Its area, or the group its category folds it into, by key. */
  area: string;
  grouped: boolean;
  category: Category | null;
  copyOf: string | null;
  reviewed: boolean;
  /** The PR's diff has the file: it can be marked. */
  inPr: boolean;
  /** Each change's head line in scope. */
  heads: number[];
  /** The file as its diff in scope names it, for the two sides. */
  diffPath: string;
  diffPrevious: string | null;
  diffStatus: FileStatus;
};

const size = (r: FileRow) => r.additions + r.deletions;

export type Area = {
  key: string;
  kind: 'area' | 'group';
  /** An area's folders before its own name (shown faint); empty for a group. */
  root: string;
  name: string;
  category: Category | null;
  rows: FileRow[];
};

export type ChangesModel = {
  /** The files in scope, in the diff's order. */
  rows: FileRow[];
  /** The areas hottest first, then the groups. */
  areas: Area[];
  /** The files not in a group, hottest first: the order `n` and `p` walk. */
  ranked: FileRow[];
};

/** What is on show: all changes, one commit (`commit`), a range (`commit` … `through`). */
export type Scope = { commit: string | null; through: string | null; since: boolean };

const baseName = (path: string) => path.split('/').at(-1) ?? path;

/** The folder part of a path, with its `/`; '' at the root. */
const dirName = (path: string) => {
  const at = path.lastIndexOf('/');

  return at < 0 ? '' : path.slice(0, at + 1);
};

/** A file's name as it reads on its own: a generic `index.ts` keeps its folder. */
export const fileName = (path: string): string => {
  const parts = path.split('/');
  const last = parts.at(-1) ?? path;

  return last.startsWith('index.') && parts.length >= 2 ? parts.slice(-2).join('/') : last;
};

/** An area's name in two parts; the top folder is left out unless another area then reads the same. */
const areaName = (key: string, keys: readonly string[]): [string, string] => {
  if (key === '') return ['', '(root)'];
  const shortOf = (k: string) => k.split('/').slice(1).join('/');
  const short = shortOf(key);
  const clash = keys.some((o) => o !== key && shortOf(o) === short);
  const shown = short === '' || clash ? key : short;

  return [dirName(shown), baseName(shown)];
};

/** Hottest first: score, then size, then path. */
const hotFirst = (a: FileRow, b: FileRow) =>
  (b.score ?? 0) - (a.score ?? 0) || size(b) - size(a) || byBytes(a.path, b.path);

const copyGroup = (original: string) => `copy:${original}`;
const mechanicalGroup = (c: Category) => `//${c}`;

const groupCategory = (key: string): Category | undefined =>
  key.startsWith('copy:') ? 'copy' : CATEGORIES.find((c) => mechanicalGroup(c) === key);

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/** The heat a file shows: a mechanical change 1; a copy 1; the rest none (size orders them). */
const scoreOf = (read: ReviewRead, path: string): number | null =>
  own(read.mechanical, path) !== undefined || own(read.copies, path) !== undefined ? 1 : null;

type Counts = {
  status: FileStatus;
  additions: number;
  deletions: number;
  heads: number[];
  diffPath: string;
  diffPrevious: string | null;
  diffStatus: FileStatus;
};

const rowOf = (
  read: ReviewRead,
  reviewed: ReadonlySet<string>,
  path: string,
  c: Counts,
): FileRow => {
  const mechanical = own(read.mechanical, path);
  const copyOf = own(read.copies, path) ?? null;
  let area = own(read.areas, path) ?? '';
  let category: Category | null = null;

  if (mechanical !== undefined) {
    area = mechanicalGroup(mechanical);
    category = mechanical;
  } else if (copyOf !== null) {
    area = copyGroup(copyOf);
    category = 'copy';
  }
  const inPr = read.files.some((f) => f.path === path);

  return {
    path,
    status: c.status,
    additions: c.additions,
    deletions: c.deletions,
    score: inPr ? scoreOf(read, path) : null,
    area,
    grouped: category !== null,
    category,
    copyOf,
    reviewed: reviewed.has(path),
    inPr,
    heads: c.heads,
    diffPath: c.diffPath,
    diffPrevious: c.diffPrevious,
    diffStatus: c.diffStatus,
  };
};

/** The files reviewed as they are now: marked with the hash their change has now. */
export const reviewedOf = (read: ReviewRead, marks: Marks | null): Set<string> =>
  new Set(
    marks === null
      ? []
      : read.files.filter((f) => own(marks.marks, f.path)?.hash === f.hash).map((f) => f.path),
  );

/** A commit's file's status: a rename's R, else the PR's for it (M when the PR lacks it). */
const commitStatus = (read: ReviewRead, path: string, renamed: boolean): FileStatus =>
  renamed ? 'R' : (read.files.find((f) => f.path === path)?.status ?? 'M');

/**
 * The files the commits `from..=to` (oldest first) changed: each once by its final path, its
 * counts summed over the range, its changes the newest commit's that changed it.
 */
const rangeRows = (read: ReviewRead, reviewed: ReadonlySet<string>, from: number, to: number) => {
  const sums = new Map<string, { additions: number; deletions: number; c: number; f: number }>();

  read.commits.slice(from, to + 1).forEach((commit, i) => {
    commit.files.forEach((cf, fi) => {
      const path = cf.finalPath ?? cf.path;
      const had = sums.get(path) ?? { additions: 0, deletions: 0, c: 0, f: 0 };

      sums.set(path, {
        additions: had.additions + cf.additions,
        deletions: had.deletions + cf.deletions,
        c: from + i,
        f: fi,
      });
    });
  });

  return [...sums.entries()].flatMap(([path, s]) => {
    const cf = read.commits[s.c]?.files[s.f];

    if (cf === undefined) return [];
    const status = commitStatus(read, path, cf.previous !== undefined);

    return [
      rowOf(read, reviewed, path, {
        status,
        additions: s.additions,
        deletions: s.deletions,
        heads: cf.heads,
        diffPath: cf.path,
        diffPrevious: cf.previous ?? null,
        diffStatus: status,
      }),
    ];
  });
};

/** Only the files changed since your review, when that is what is on show. */
const sinceFilter = (read: ReviewRead, scope: Scope, rows: FileRow[]) =>
  scope.since && read.since !== null
    ? rows.filter((r) => read.since?.paths.includes(r.path) === true)
    : rows;

/** The rows in scope: every file of the PR, or those the commit (or range) changed with its counts. */
const scopedRows = (read: ReviewRead, reviewed: ReadonlySet<string>, scope: Scope) => {
  const at = (sha: string | null) =>
    sha === null ? -1 : read.commits.findIndex((c) => c.sha === sha);
  const from = at(scope.commit);
  const to = at(scope.through);

  if (from >= 0 && to >= 0 && from !== to)
    return sinceFilter(
      read,
      scope,
      rangeRows(read, reviewed, Math.min(from, to), Math.max(from, to)),
    );
  const commit: ReadCommit | undefined = from >= 0 ? read.commits[from] : undefined;
  const rows =
    commit === undefined
      ? read.files.map((f) =>
          rowOf(read, reviewed, f.path, {
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            heads: f.heads,
            diffPath: f.path,
            diffPrevious: f.previous ?? null,
            diffStatus: f.status,
          }),
        )
      : commit.files.map((cf) => {
          const path = cf.finalPath ?? cf.path;
          const status = commitStatus(read, path, cf.previous !== undefined);

          return rowOf(read, reviewed, path, {
            status,
            additions: cf.additions,
            deletions: cf.deletions,
            heads: cf.heads,
            diffPath: cf.path,
            diffPrevious: cf.previous ?? null,
            diffStatus: status,
          });
        });

  return sinceFilter(read, scope, rows);
};

/** The groups the grouped rows fall into: each mechanical kind, and the copies of each file. */
const groupsOf = (rows: readonly FileRow[]): Area[] => {
  const keys: string[] = [];

  for (const r of rows) if (r.grouped && !keys.includes(r.area)) keys.push(r.area);
  const order = (k: string) => CATEGORIES.indexOf(groupCategory(k) ?? 'copy');

  keys.sort((a, b) => order(a) - order(b) || byBytes(a, b));

  return keys.map((key) => {
    const category = groupCategory(key) ?? 'copy';
    const original = key.startsWith('copy:') ? key.slice('copy:'.length) : undefined;

    return {
      key,
      kind: 'group',
      root: '',
      name: original === undefined ? CATEGORY_LABEL[category] : `copy of ${fileName(original)}`,
      category,
      rows: rows.filter((r) => r.area === key).sort((a, b) => byBytes(a.path, b.path)),
    };
  });
};

/** The changes of a read in a scope: rows, areas hottest first then groups, and the ranked list. */
export const changesModel = (read: ReviewRead, marks: Marks | null, scope: Scope): ChangesModel => {
  const rows = scopedRows(read, reviewedOf(read, marks), scope);
  const open = rows.filter((r) => !r.grouped);
  const keys: string[] = [];

  for (const r of open) if (!keys.includes(r.area)) keys.push(r.area);
  const areas: Area[] = keys.map((key) => {
    const [root, name] = areaName(key, keys);

    return {
      key,
      kind: 'area',
      root,
      name,
      category: null,
      rows: open.filter((r) => r.area === key).sort(hotFirst),
    };
  });
  const maxScore = (a: Area) => Math.max(0, ...a.rows.map((r) => r.score ?? 0));
  const sumScore = (a: Area) => a.rows.reduce((n, r) => n + (r.score ?? 0), 0);
  const sumSize = (a: Area) => a.rows.reduce((n, r) => n + size(r), 0);

  areas.sort(
    (a, b) =>
      maxScore(b) - maxScore(a) ||
      sumScore(b) - sumScore(a) ||
      sumSize(b) - sumSize(a) ||
      byBytes(a.key, b.key),
  );
  const place = (path: string) => {
    for (const [i, a] of areas.entries()) {
      const at = a.rows.findIndex((r) => r.path === path);

      if (at >= 0) return i * 10_000 + at;
    }

    return 0;
  };
  const ranked = [...open].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0) || place(a.path) - place(b.path),
  );

  return { rows, areas: [...areas, ...groupsOf(rows)], ranked };
};

// ---- the screen ----

/** How the files pane lists: a folder tree, areas hottest first, or every file by heat. */
export type Listing = 'tree' | 'areas' | 'ranked';

const NEXT_LISTING: Readonly<Record<Listing, Listing>> = {
  tree: 'areas',
  areas: 'ranked',
  ranked: 'tree',
};

/** Where the pane stands: the listing, folds, cursor, change in focus and scope. */
export type ChangesView = {
  list: Listing;
  /** Fold keys flipped from how they start (`d:` folder, `a:` area open; `g:` group folded). */
  toggled: string[];
  /** The file the cursor is on; with no node either, it starts on the hottest file not reviewed. */
  file: string | null;
  node: string | null;
  /** The change in focus in the cursor's file; none before stepping into it. */
  hunk: number | null;
  /** The commit in scope (a range's oldest); none for all changes. */
  commit: string | null;
  /** A range's newest commit; none for all changes or one commit. */
  through: string | null;
  /** The whole PR on show though files changed since your review. */
  whole: boolean;
};

export const CHANGES_START: ChangesView = {
  list: 'tree',
  toggled: [],
  file: null,
  node: null,
  hunk: null,
  commit: null,
  through: null,
  whole: false,
};

export type NodeKind = 'dir' | 'area' | 'group';

/** A folder of the tree, an area, or a group: a line that folds what is under it. */
export type NodeLine = {
  key: string;
  node: NodeKind;
  label: string;
  depth: number;
  open: boolean;
  /** Every file under it, folded or not. */
  rows: FileRow[];
};

export type PanelLine =
  | { kind: 'node'; node: NodeLine }
  | { kind: 'file'; row: FileRow; depth: number; label: string }
  /** A faint rule between heats. */
  | { kind: 'band' }
  /** A gap before the groups. */
  | { kind: 'gap' };

const isStop = (l: PanelLine) => l.kind === 'node' || l.kind === 'file';
const rowOfLine = (l: PanelLine | undefined) => (l?.kind === 'file' ? l.row : undefined);

/** Everything the pane shows and its keys act on, from a read, the marks and the view. */
export type ChangesScreen = {
  model: ChangesModel;
  scope: Scope;
  /** The commit in scope by its place, oldest first; none for all changes. */
  commitIndex: number | null;
  /** A range's newest commit by its place; none otherwise. */
  throughIndex: number | null;
  lines: PanelLine[];
  /** The line the cursor is on; none when the panel is empty. */
  at: number | null;
  /** The file the cursor is on; none on a node. */
  row: FileRow | null;
  node: NodeLine | null;
  hunk: number | null;
  /** The files ⏎ walks, in the panel's order: those on show, a folded group's left out. */
  steps: FileRow[];
};

/** Folders and areas start open, groups folded; `toggled` flips them. */
const isOpen = (toggled: readonly string[], key: string, start: boolean) =>
  start !== toggled.includes(key);

type Folder = { name: string; path: string; dirs: Folder[]; files: FileRow[] };

const folderOf = (rows: readonly FileRow[]): Folder => {
  const root: Folder = { name: '', path: '', dirs: [], files: [] };

  for (const row of rows) {
    let folder = root;

    for (const name of row.path.split('/').slice(0, -1)) {
      let next = folder.dirs.find((d) => d.name === name);

      if (next === undefined) {
        next = {
          name,
          path: folder.path === '' ? name : `${folder.path}/${name}`,
          dirs: [],
          files: [],
        };
        folder.dirs.push(next);
      }
      folder = next;
    }
    folder.files.push(row);
  }

  return root;
};

const allRows = (folder: Folder): FileRow[] => [...folder.dirs.flatMap(allRows), ...folder.files];

/** The folder tree: folders first by name (one with only a folder in it folded into one line), then files. */
const treeLines = (rows: readonly FileRow[], toggled: readonly string[]): PanelLine[] => {
  const out: PanelLine[] = [];
  const walk = (folder: Folder, depth: number) => {
    for (const child of [...folder.dirs].sort((a, b) => byBytes(a.name, b.name))) {
      let node = child;
      let label = child.name;
      const only = (f: Folder) =>
        f.files.length === 0 && f.dirs.length === 1 ? f.dirs[0] : undefined;

      for (let next = only(node); next !== undefined; next = only(node)) {
        node = next;
        label = `${label}/${node.name}`;
      }
      const key = `d:${node.path}`;
      const open = isOpen(toggled, key, true);

      out.push({
        kind: 'node',
        node: { key, node: 'dir', label: `${label}/`, depth, open, rows: allRows(node) },
      });
      if (open) walk(node, depth + 1);
    }
    for (const row of [...folder.files].sort((a, b) => byBytes(a.path, b.path)))
      out.push({ kind: 'file', row, depth, label: baseName(row.path) });
  };

  walk(folderOf(rows), 0);

  return out;
};

/** An area's or group's line, and its files under it while open. */
const areaLines = (area: Area, toggled: readonly string[]): PanelLine[] => {
  const key = `${area.kind === 'area' ? 'a' : 'g'}:${area.key}`;
  const open = isOpen(toggled, key, area.kind === 'area');
  const inArea = (row: FileRow) =>
    area.kind === 'area' && area.key !== '' ? row.path.slice(area.key.length + 1) : row.path;

  return [
    {
      kind: 'node',
      node: {
        key,
        node: area.kind,
        label: `${area.root}${area.name}`,
        depth: 0,
        open,
        rows: area.rows,
      },
    },
    ...(open
      ? area.rows.map((row): PanelLine => ({ kind: 'file', row, depth: 1, label: inArea(row) }))
      : []),
  ];
};

/** The groups, folded until opened, after a gap. */
const groupLines = (model: ChangesModel, toggled: readonly string[]): PanelLine[] => {
  const groups = model.areas.filter((a) => a.kind === 'group');

  return groups.length === 0
    ? []
    : [{ kind: 'gap' }, ...groups.flatMap((g) => areaLines(g, toggled))];
};

/** Every file not in a group by heat, a faint rule between heats. */
const rankedLines = (model: ChangesModel): PanelLine[] =>
  model.ranked.flatMap((row, i): PanelLine[] => [
    ...(i > 0 && model.ranked[i - 1]?.score !== row.score ? [{ kind: 'band' as const }] : []),
    { kind: 'file', row, depth: 0, label: row.path },
  ]);

const panelLines = (view: ChangesView, model: ChangesModel): PanelLine[] => {
  if (view.list === 'tree') return treeLines(model.rows, view.toggled);
  if (view.list === 'ranked') return [...rankedLines(model), ...groupLines(model, view.toggled)];

  return [
    ...model.areas.filter((a) => a.kind === 'area').flatMap((a) => areaLines(a, view.toggled)),
    ...groupLines(model, view.toggled),
  ];
};

/** The screen over a read with the marks as they are now. */
export const changesScreen = (
  read: ReviewRead,
  marks: Marks | null,
  view: ChangesView,
): ChangesScreen => {
  const indexOf = (sha: string | null) => {
    const i = sha === null ? -1 : read.commits.findIndex((c) => c.sha === sha);

    return i < 0 ? null : i;
  };
  const commitIndex = indexOf(view.commit);
  const t = indexOf(view.through);
  const throughIndex = t !== null && commitIndex !== null && commitIndex !== t ? t : null;
  const scope: Scope = {
    commit: commitIndex === null ? null : (read.commits[commitIndex]?.sha ?? null),
    through: throughIndex === null ? null : (read.commits[throughIndex]?.sha ?? null),
    since: !view.whole && read.since !== null,
  };
  const model = changesModel(read, marks, scope);
  const lines = panelLines(view, model);
  const findFile = (path: string) => {
    const i = lines.findIndex((l) => rowOfLine(l)?.path === path);

    return i < 0 ? null : i;
  };
  let at: number | null = null;

  if (view.node !== null) {
    const i = lines.findIndex((l) => l.kind === 'node' && l.node.key === view.node);

    at = i < 0 ? null : i;
  } else if (view.file !== null) at = findFile(view.file);
  if (at === null && view.node === null && view.file === null) {
    const hot = model.ranked.find((r) => !r.reviewed);

    at = hot === undefined ? null : findFile(hot.path);
  }
  if (at === null) {
    const i = lines.findIndex(isStop);

    at = i < 0 ? null : i;
  }
  const here = at === null ? undefined : lines[at];
  const row = rowOfLine(here) ?? null;
  const node = here?.kind === 'node' ? here.node : null;
  const steps = lines
    .flatMap((l) => (l.kind === 'file' ? [l.row] : []))
    .filter((r) => !(r.grouped && !isOpen(view.toggled, `g:${r.area}`, false)));

  return {
    model,
    scope,
    commitIndex,
    throughIndex,
    lines,
    at,
    row,
    node,
    hunk: row !== null && row.path === view.file ? view.hunk : null,
    steps,
  };
};

/** A change to show: a file at its change `hunk`, and the head line the diff scrolls to. */
export type Change = { row: FileRow; hunk: number; line: number };

export const changeAt = (row: FileRow, hunk: number): Change => ({
  row,
  hunk,
  line: row.heads[hunk] ?? 1,
});

/**
 * Where ⏎ (`step` 1) or ⇧⏎ (-1) goes from the cursor: the next change in its file, else the next
 * file ⏎ walks at its first change (the previous file at its last); none at either end. On a
 * node, the file after it or before it.
 */
export const nextChange = (screen: ChangesScreen, step: 1 | -1): Change | undefined => {
  const row = screen.row;

  if (row !== null) {
    const count = row.heads.length;

    if (step === 1 && screen.hunk === null) return changeAt(row, 0);
    if (step === 1 && screen.hunk !== null && screen.hunk + 1 < count)
      return changeAt(row, screen.hunk + 1);
    if (step === -1 && screen.hunk !== null && screen.hunk > 0)
      return changeAt(row, screen.hunk - 1);
  }
  const at = screen.at;

  if (at === null) return undefined;
  const walked = (r: FileRow) => screen.steps.some((s) => s.path === r.path);
  const files = screen.lines.flatMap((l, i) =>
    l.kind === 'file' && walked(l.row) ? [{ i, row: l.row }] : [],
  );
  const next = step === 1 ? files.find((f) => f.i > at) : files.filter((f) => f.i < at).at(-1);

  if (next === undefined) return undefined;

  return changeAt(next.row, step === 1 ? 0 : Math.max(0, next.row.heads.length - 1));
};

/** What ⏎ or ⇧⏎ says at either end. */
export const endOfChanges = (step: 1 | -1): string =>
  step === 1 ? 'The last change of the last file' : 'The first change';

/**
 * The file `n` (`step` 1) or `p` (-1) goes to: the next one not reviewed in the ranked order from
 * the cursor's, round past the end; none when every one is reviewed.
 */
export const nextUnreviewed = (screen: ChangesScreen, step: 1 | -1): FileRow | undefined => {
  const walk = step === 1 ? screen.model.ranked : [...screen.model.ranked].reverse();
  const from = screen.row === null ? -1 : walk.findIndex((w) => w.path === screen.row?.path);
  const order = from < 0 ? walk : [...walk.slice(from + 1), ...walk.slice(0, from)];

  return order.find((r) => !r.reviewed);
};

export const NOTHING_LEFT = '✓ Nothing left to review';

/** The fold keys with `key` flipped. */
export const toggleFold = (view: ChangesView, key: string): string[] =>
  view.toggled.includes(key) ? view.toggled.filter((t) => t !== key) : [...view.toggled, key];

/** The cursor on a file at change `hunk`, the folder, area or group that hides it opened. */
export const reveal = (view: ChangesView, row: FileRow, hunk: number | null): ChangesView => {
  const shown = view.toggled.filter(
    (key) =>
      !(key.startsWith('d:') && row.path.startsWith(`${key.slice(2)}/`)) && key !== `a:${row.area}`,
  );
  const group = `g:${row.area}`;

  return {
    ...view,
    file: row.path,
    node: null,
    hunk,
    toggled: row.grouped && !shown.includes(group) ? [...shown, group] : shown,
  };
};

const onLine = (view: ChangesView, line: PanelLine | undefined): ChangesView => {
  if (line?.kind === 'file') return { ...view, file: line.row.path, node: null, hunk: null };
  if (line?.kind === 'node') return { ...view, node: line.node.key, file: null, hunk: null };

  return view;
};

/** ↑↓: over the panel's nodes and files. */
export const moveCursor = (
  screen: ChangesScreen,
  view: ChangesView,
  delta: number,
): ChangesView => {
  const stops = screen.lines.flatMap((l, i) => (isStop(l) ? [i] : []));

  if (stops.length === 0) return view;
  const place = Math.max(0, stops.indexOf(screen.at ?? -1));
  const to = Math.min(stops.length - 1, Math.max(0, place + delta));

  return onLine(view, screen.lines[stops[to] ?? 0]);
};

/** The cursor on line `index` (a click); a line no cursor stops on, or past the end, moves nothing. */
export const pointAt = (screen: ChangesScreen, view: ChangesView, index: number): ChangesView =>
  onLine(view, screen.lines[index]);

/** ←→: `→` opens a folded node; `←` folds an open node, else goes to the node over the cursor. */
export const sideways = (screen: ChangesScreen, view: ChangesView, step: 1 | -1): ChangesView => {
  const node = screen.node;

  if (node !== null && node.open !== (step === 1))
    return { ...view, toggled: toggleFold(view, node.key) };
  if (step === 1 || screen.row === null || screen.at === null) return view;
  const here = screen.lines[screen.at];
  const depth = here?.kind === 'file' ? here.depth : 0;
  const parent = screen.lines
    .slice(0, screen.at)
    .reverse()
    .find((l) => l.kind === 'node' && l.node.depth < depth);

  return parent?.kind === 'node'
    ? { ...view, node: parent.node.key, file: null, hunk: null }
    : view;
};

/** `[` (-1) and `]` (1): the commit scope before or after, round through all changes. */
export const stepCommit = (
  screen: ChangesScreen,
  read: ReviewRead,
  view: ChangesView,
  step: 1 | -1,
): ChangesView | string => {
  if (read.commits.length === 0) return 'No commits read: the PR is not checked out';
  const n = read.commits.length;
  let index = (screen.commitIndex ?? -1) + step;

  if (index >= n) index = -1;
  if (index < -1) index = n - 1;

  return {
    ...view,
    commit: index < 0 ? null : (read.commits[index]?.sha ?? null),
    through: null,
    hunk: null,
  };
};

/**
 * The Log's selection as the scope: no commit is all changes, one is that commit, more are the
 * range from the oldest to the newest. Commits the read lacks are left out.
 */
export const scopeTo = (
  read: ReviewRead,
  view: ChangesView,
  shas: readonly string[],
): ChangesView => {
  const places = shas.flatMap((sha) => {
    const i = read.commits.findIndex(
      (c) => c.sha === sha || (sha.length >= 7 && c.sha.startsWith(sha)),
    );

    return i < 0 ? [] : [i];
  });
  const a = places.length === 0 ? undefined : Math.min(...places);
  const b = places.length === 0 ? undefined : Math.max(...places);
  const sha = (i: number | undefined) => (i === undefined ? null : (read.commits[i]?.sha ?? null));

  return {
    ...view,
    commit: sha(a),
    through: a !== undefined && b !== undefined && a !== b ? sha(b) : null,
    hunk: null,
  };
};

export const plural = (n: number, noun: string): string =>
  n === 1 ? `1 ${noun}` : `${n} ${noun}s`;

const copiesNote = (n: number): string => {
  if (n === 0) return '';

  return n === 1 ? ' + its copy' : ` + its ${n} copies`;
};

/** What Space (`copies`: with the copies) on the cursor marks: the paths, on or off, and the words. */
export type Marking = { paths: string[]; on: boolean; said: string; tone: 'ok' | 'info' };

/**
 * Space on a file toggles its mark; with `copies` it and every copy of it. On a node: all its PR
 * files reviewed → all back to review, else all reviewed. Only files in the PR's diff are marked.
 */
export const markFocus = (
  screen: ChangesScreen,
  read: ReviewRead,
  copies: boolean,
): Marking | undefined => {
  if (screen.node !== null) {
    const rows = screen.node.rows.filter((r) => r.inPr);

    if (rows.length === 0) return undefined;
    const on = !rows.every((r) => r.reviewed);
    const count = plural(rows.length, 'file');

    return {
      paths: rows.map((r) => r.path),
      on,
      said: on
        ? `✓ ${count} in ${screen.node.label} reviewed`
        : `○ ${count} in ${screen.node.label} back to review`,
      tone: on ? 'ok' : 'info',
    };
  }
  const row = screen.row;

  if (!row?.inPr) return undefined;
  const others = copies
    ? read.files.filter((f) => own(read.copies, f.path) === row.path).map((f) => f.path)
    : [];
  const on = !row.reviewed;
  const note = copiesNote(others.length);
  const name = `${baseName(row.path)}${note}`;

  return {
    paths: [row.path, ...others],
    on,
    said: on ? `✓ ${name}` : `○ ${name} back to review`,
    tone: on ? 'ok' : 'info',
  };
};

export const nextListing = (list: Listing): Listing => NEXT_LISTING[list];
