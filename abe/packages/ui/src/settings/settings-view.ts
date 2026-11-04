/**
 * The Settings dialog drawn (#345 split of `settings.ts`): the tree, the page or `/`'s results, the
 * popups, the footer.
 */
import {
  type ListedRow,
  type PageId,
  type SettingRow as CatalogueRow,
  type SettingsDialogRules,
  type SettingsProblem,
  type TreeNode,
} from '@abe/core';
import { isInfoRow, problemsOnly, prsText } from './settings-words';
import { type Node } from '../runtime/components';
import {
  type ComboChoice,
  type ProblemRow,
  type SettingControl,
  type SettingRow,
  type SettingsGroup,
  type SettingsTone,
  type SettingsTreeRow,
} from './settings-components';
import { colourNode, coloursPage, themeCell, themeRows } from './settings-colours';
import { importPage } from './settings-import';
import { localPage } from './settings-local';
import { fixNode, loginsPage, problemFixId } from './settings-logins';
import { profilesPage } from './settings-profiles';
import { proposeNode } from './settings-propose';
import {
  type Line,
  type SettingLine,
  choiceWords,
  choicesOf,
  feelGives,
  feelName,
  hitsOf,
  hitsOn,
  isFixed,
  pageLines,
  resultGroups,
  results,
  searching,
  shownOf,
  valueOf,
  wordOf,
} from './settings-rows';
import { linkText, resettable, shownSlug, comboChoices, noneWords } from './settings-change';
import { recordsControl } from './settings-records';
import { listControl } from './settings-list';
import {
  COLOURS_PAGE,
  IMPORT_PAGE,
  LOCAL_PAGE,
  LOGINS_PAGE,
  PROFILES_PAGE,
  type SettingsState,
  THEME_KEY,
  editingOf,
  plural,
  proposingOf,
} from './settings-state';
import { hasHits, pageShown, problemCount, problemRows, visible } from './settings-tree';

/** No page yet: a first open waits for Problems, unless you moved first (#297). */
export const held = (s: SettingsState) => s.holding && !s.moved && s.search === null;

const READING = 'Reading settings…';

/** The page says `Reading settings…`: its rows are not drawn, so no key acts on them. */
export const unread = (r: SettingsDialogRules, s: SettingsState): boolean => {
  if (held(s)) return true;
  if (results(s) !== undefined || s.list !== undefined || s.down !== undefined) return false;
  const page = pageShown(r, s);

  return page !== 'problems' && page !== LOGINS_PAGE && page !== IMPORT_PAGE;
};

/** A row on one of Abe's pages (`Abe › …`): the Factory's settings, each from the repo, yours or Abe. */
const abePage = (r: SettingsDialogRules, row: CatalogueRow): boolean =>
  r.page(row.page).crumb.startsWith('Abe ›');

const sourceOf = (
  r: SettingsDialogRules,
  s: SettingsState,
  row: CatalogueRow,
  listed: ListedRow | undefined,
): SettingRow['props']['source'] => {
  const c = s.changes[row.id];
  const state = c?.saved === undefined ? 'saving…' : 'saved';

  if (c?.reset === true) return { text: `reset to default · ${state}`, tone: 'link' };
  if (c !== undefined) return { text: `yours · ${state}`, tone: 'link' };
  // a link row's value is its home row's, which says where it comes from (#345)
  if (row.link !== null) return { text: '' };
  if (listed === undefined) return { text: s.down === undefined ? 'reading…' : 'not read' };
  const feel = feelGives(s, row.key, listed);

  if (feel !== undefined)
    return { text: `from Feel ${feelName(r, feel.feel)} · saving…`, tone: 'link' };
  if (listed.fixed !== null) return { text: `fixed · ${listed.fixed.why}` };
  // only a real source (#345): the editor's built-in value says nothing, every row would carry
  // it; Abe's pages say each row's, built-in too, so Repo, Yours and built-in read at a glance
  const said =
    listed.differs?.text ??
    (listed.source.kind === 'built-in' && !abePage(r, row) ? undefined : listed.source.text);
  const parts = said === undefined ? [] : [said];

  if (listed.lowered !== null) parts.push(`✎ ${listed.lowered}`);
  parts.push(...greyedWords(row, listed.greyed));
  return {
    text: parts.join(' · '),
    ...(listed.lowered === null ? {} : { tone: 'warn' as const }),
  };
};

/**
 * The greyed choices, one line per reason (#300: Box size's four sizes over the largest said
 * once): `haiku greyed, <why>`, `4 choices greyed, <why>`.
 */
const greyedWords = (row: CatalogueRow, greyed: ListedRow['greyed']): string[] => {
  const byWhy = new Map<string, string[]>();

  for (const g of greyed) byWhy.set(g.why, [...(byWhy.get(g.why) ?? []), g.choice]);

  return [...byWhy].map(([why, choices]) =>
    choices.length === 1
      ? `${wordOf(row, choices[0] ?? '')} greyed, ${why}`
      : `${choices.length} choices greyed, ${why}`,
  );
};

/** A combo's choice in its list: none's words for no value, else the choice's. */
const comboText = (row: CatalogueRow, choice: string): string =>
  choice === '' ? noneWords(row) : choiceWords(row, choice);

const controlOf = (
  r: SettingsDialogRules,
  s: SettingsState,
  row: CatalogueRow,
  listed: ListedRow | undefined,
  at: number,
): SettingControl => {
  const id = row.id;
  const e = editingOf(s)?.row === id ? editingOf(s) : undefined;
  const shown = shownOf(r, s, row, listed);
  const value = valueOf(s, row, listed);

  if (listed?.fixed !== undefined && listed.fixed !== null)
    return row.control === 'checkbox'
      ? { kind: 'checkbox', on: shown === 'on', fixed: true }
      : { kind: 'value', text: shown };
  switch (row.control) {
    case 'checkbox':
      return { kind: 'checkbox', on: value === true };
    case 'combo': {
      // no value: what none means here (`none · the default profile`)
      const said =
        row.clearable && (value === null || value === undefined || value === '')
          ? noneWords(row)
          : choiceWords(row, shown);

      if (e?.kind !== 'combo') return { kind: 'combo', value: said };
      const choices: ComboChoice[] = comboChoices(row, listed, e.filter).map((c, i) => ({
        id: `settings:choice:${i}`,
        text: c.typed === true ? `Use “${c.choice}”` : comboText(row, c.choice),
        ...(c.greyed === undefined ? {} : { greyed: c.greyed }),
      }));

      return { kind: 'combo', value: said, open: { choices, cursor: e.cursor, filter: e.filter } };
    }
    case 'segmented': {
      const values = choicesOf(row, listed);
      const choices = values.map((c) => choiceWords(row, c));
      const on = choiceWords(row, e?.kind === 'segmented' ? (values[e.at] ?? shown) : shown);

      return e?.kind === 'segmented'
        ? { kind: 'segmented', choices, on, editing: true }
        : { kind: 'segmented', choices, on };
    }
    case 'text':
    case 'number': {
      // one width per kind (#345): it never grows while typed in
      const look = {
        size: row.control === 'number' ? ('number' as const) : row.size,
        ...(row.unit === null ? {} : { unit: row.unit }),
      };

      return e?.kind === 'field'
        ? { kind: 'field', text: e.text, editing: true, ...look }
        : { kind: 'field', text: shown === '—' ? '' : shown, ...look };
    }
    case 'chips':
      return listControl(r, s, row, listed, e?.kind === 'list' ? e : undefined, at);
    case 'records':
      return recordsControl(r, s, row, listed, e?.kind === 'records' ? e : undefined);
    case 'path': {
      const browse = { id: `settings:browse:${at}`, label: 'Choose…' };

      return e?.kind === 'field'
        ? { kind: 'path', text: e.text, editing: true, browse }
        : { kind: 'path', text: shown === '—' ? '' : shown, browse };
    }
    case 'secret':
      return e?.kind === 'field'
        ? {
            kind: 'secret',
            set: value !== null && value !== undefined,
            editing: true,
            typed: Array.from(e.text).length,
          }
        : { kind: 'secret', set: value !== null && value !== undefined && value !== '' };
    case 'advanced':
      return e?.kind === 'field'
        ? { kind: 'advanced', text: e.text, editing: true }
        : {
            kind: 'advanced',
            text: value === null || value === undefined ? '' : JSON.stringify(value),
          };
    case 'preview': {
      if (row.key !== THEME_KEY || themeRows(s).length === 0) return { kind: 'value', text: shown };
      const on = listed === undefined ? '' : shownSlug(s, row, listed);

      return {
        kind: 'themes',
        themes: themeRows(s).map(themeCell),
        on,
        ...(e?.kind === 'themes' ? { cursor: e.cursor } : {}),
      };
    }
    case 'table':
      return { kind: 'value', text: shown };
    case 'link':
      return { kind: 'value', text: row.link === null ? shown : linkText(r, s, row.link) };
  }
};

/** A named entry (`{ name, run }`, a check) as its name; any other item as it is written. */
const named = (x: unknown): { name: string; run: string | null } | undefined => {
  if (typeof x !== 'object' || x === null || !('name' in x) || typeof x.name !== 'string')
    return undefined;

  return { name: x.name, run: 'run' in x && typeof x.run === 'string' ? x.run : null };
};

/** A chips row's help: each named entry's command first (`tests: npm test`), then its own. */
const chipsHelp = (row: CatalogueRow, value: unknown): string => {
  const runs = (Array.isArray(value) ? value : []).flatMap((x) => {
    const n = named(x);

    return n?.run === null || n === undefined ? [] : [`${n.name}: ${n.run}`];
  });

  return [...runs, ...(row.help === '' ? [] : [row.help])].join(' · ');
};

/** What ⏎ does on a row, by its control. */
const ENTER: Partial<Record<CatalogueRow['control'], string>> = {
  checkbox: 'Space or ⏎ toggle',
  combo: '⏎ choose',
  segmented: '⏎ choose',
  chips: '⏎ edit the list',
  records: '⏎ edit the rows',
  path: '⏎ type · ⌘O choose',
  advanced: '⏎ edit JSON',
};

const hintOf = (
  row: CatalogueRow,
  listed: ListedRow | undefined,
  canReset: boolean,
): string | undefined => {
  if (row.link !== null) return '⏎ go there';
  if (listed === undefined || isFixed(listed)) return undefined;
  const enter =
    row.control === 'combo' && row.free
      ? '⏎ choose or type'
      : (ENTER[row.control] ?? '⏎ change for me');
  const reset = canReset ? ' · ⌫ reset' : '';

  if (row.personalOnly) return `${enter}${reset} · yours alone: not for the repo`;

  return `${enter}${reset} · ⌘⏎ propose for the repo`;
};

/**
 * The default a row says: none while the built-in value is in force (it is the default), nor
 * when its source line already says it (`Yours · the default is none`).
 */
const defaultSaid = (listed: ListedRow | undefined): string | undefined =>
  listed?.default === null ||
  listed?.default === undefined ||
  listed.source.kind === 'built-in' ||
  listed.differs?.layer === 'core'
    ? undefined
    : listed.default;

export const settingNode = (
  r: SettingsDialogRules,
  s: SettingsState,
  line: SettingLine,
  at: number,
): SettingRow => {
  const { row, listed } = line;
  const id = row.id;
  const focused = s.focus === 'page' && s.row === at;
  const editing = editingOf(s);
  const e = editing?.kind === 'reason' && editing.row === id ? editing : undefined;
  const error = s.errors[id];
  const hit = hitsOn(r, s).has(id);
  // the theme list's cells fill the row: no hint over them
  const canReset = resettable(row, listed) && s.changes[id]?.reset !== true;
  const hint = focused && row.key !== THEME_KEY ? hintOf(row, listed, canReset) : undefined;
  const control = controlOf(r, s, row, listed, at);
  const source = sourceOf(r, s, row, listed);
  const scope = listed?.scope ?? undefined;
  const said = defaultSaid(listed);
  const reset = canReset;
  // ... nor a help or a plain source line: each cell says its own (`built-in · current`), and a
  // row's line drew right of the cells or under the last one's (#325: `built-in built-in`)
  const cells = control.kind === 'themes';
  const help = control.kind === 'list' ? chipsHelp(row, valueOf(s, row, listed)) : row.help;

  return {
    kind: 'SettingRow',
    id: `settings:line:${at}`,
    props: {
      label: row.label,
      control,
      // a fixed line's help that only repeats its value is left out
      ...(cells || help === '' || help === row.fixed?.value ? {} : { help }),
      // a pick being saved or a Feel's still says so
      source: cells && source.tone !== 'link' ? { text: '' } : source,
      ...(scope === undefined || row.link !== null ? {} : { scope }),
      ...(said === undefined || cells ? {} : { default: said }),
      ...(reset ? { reset: { id: `settings:reset:${at}`, label: 'Reset' } } : {}),
      ...(hint === undefined ? {} : { hint }),
      ...(focused ? { focused } : {}),
      ...(hit ? { hit } : {}),
      ...(s.changes[id] === undefined ? {} : { changed: true }),
      ...(error === undefined ? {} : { error }),
      ...(listed === undefined || listed.prs.length === 0 ? {} : { pr: prsText(listed.prs) }),
      ...(e === undefined
        ? {}
        : { reason: { text: e.text, ...(e.error === undefined ? {} : { error: e.error }) } }),
    },
  };
};

/** A row's way out as its button says it: an info row's is a proposal, suggested (#168). */
const wayLabel = (s: SettingsState, p: SettingsProblem): ProblemRow['props']['way'] => {
  if (isInfoRow(p)) return { label: 'propose…' };
  // one button word (#345): `fix…` for every way but a file opened in the Editor
  if (p.way.kind === 'file') return { label: 'open' };
  if (p.way.kind !== 'fix') return { label: 'fix…', tone: 'warn' };
  const f = s.fix;
  const mine = f?.item === problemFixId(p, p.way.command);

  // its fix in the strip: the row says what ⏎ does now, as a check row does (#300)
  if (mine && f.state === 'queued') return { label: 'queued · ⏎ runs it', tone: 'warn' };

  return { label: 'fix…', tone: 'warn' };
};

const problemNode = (s: SettingsState, p: SettingsProblem, at: number): ProblemRow => ({
  kind: 'ProblemRow',
  id: `settings:line:${at}`,
  props: {
    text: p.text,
    where: p.where,
    way: wayLabel(s, p),
    ...(isInfoRow(p) ? { info: true } : {}),
    ...(s.focus === 'page' && s.row === at ? { focused: true } : {}),
  },
});

/** A group's caption, none on a group of one row: its label says it (FEEL above Feel). */
export const captionOf = (
  caption: string | null,
  rows: readonly unknown[],
): { caption?: string } => (caption === null || rows.length === 1 ? {} : { caption });

/** Lines in groups by their caption, numbered on from `first`. */
const grouped = (
  r: SettingsDialogRules,
  s: SettingsState,
  ls: readonly SettingLine[],
  first: number,
  caption: (l: CatalogueRow) => string | null,
): SettingsGroup[] => {
  const groups: { caption: string | null; rows: SettingRow[] }[] = [];

  ls.forEach((line, i) => {
    const c = caption(line.row);
    const last = groups.at(-1);
    const node = settingNode(r, s, line, first + i);

    if (last?.caption === c) last.rows.push(node);
    else groups.push({ caption: c, rows: [node] });
  });

  return groups.map((g, i) => ({
    kind: 'SettingsGroup',
    id: `settings:group:${i}`,
    props: captionOf(g.caption, g.rows),
    children: g.rows,
  }));
};

const settingLines = (ls: readonly Line[]) =>
  ls.filter((l): l is SettingLine => l.kind === 'setting');

/** Which child holds the focused line, for the shell to scroll to. */
const revealOf = (children: readonly Node[], row: number): string | undefined => {
  const want = `settings:line:${row}`;
  const holds = (n: Node): boolean =>
    n.id === want || ('children' in n && (n.children ?? []).some((c) => holds(c)));

  return children.find((c) => holds(c))?.id;
};

/** A page `/` found by its name: its path as the source line, ⏎ opens it. */
const pageHitNode = (
  r: SettingsDialogRules,
  s: SettingsState,
  page: PageId,
  at: number,
): SettingRow => {
  const focused = s.focus === 'page' && s.row === at;
  const p = r.page(page);

  return {
    kind: 'SettingRow',
    id: `settings:line:${at}`,
    props: {
      label: p.label,
      control: { kind: 'value', text: 'page' },
      source: { text: p.crumb },
      ...(focused ? { focused, hint: '⏎ open the page' } : {}),
    },
  };
};

const pageNode = (r: SettingsDialogRules, s: SettingsState): Node => {
  const q = results(s);
  const scope = s.list?.scope.text ?? '';

  if (q !== undefined) {
    const { hits, groups } = resultGroups(r, s, q);

    if (hits.total === 0) {
      const none = r.noMatch(q);

      return page(['Search'], '', [empty(none.text, none.hint)], s.row);
    }
    let at = 0;
    const children = groups.map((g, i): SettingsGroup => {
      const first = at;

      at += g.lines.length;

      return {
        kind: 'SettingsGroup',
        id: `settings:results:${i}`,
        props: { caption: g.label },
        children: g.lines.flatMap((line, j): SettingRow[] => {
          if (line.kind === 'page-hit') return [pageHitNode(r, s, line.page, first + j)];

          if (line.kind === 'token') {
            const token = colourNode(s, line, first + j);

            return token === undefined ? [] : [token];
          }

          return line.kind === 'setting' ? [settingNode(r, s, line, first + j)] : [];
        }),
      };
    });

    // the crumb says Search: the scope is the count (`5 settings on 3 pages`)
    return page(['Search'], r.summary(hits).replace(/^Search · /, ''), children, s.row);
  }
  if (held(s)) return page(['Settings'], '', [empty(READING)], s.row);
  const id = pageShown(r, s);
  const catalogue = r.page(id);
  const crumbs = catalogue.crumb.split(' › ');

  if (id === LOGINS_PAGE) return loginsPage(r, s, crumbs);
  if (id === IMPORT_PAGE) return importPage(r, s, crumbs);
  if (id === PROFILES_PAGE && s.list !== undefined) return profilesPage(r, s, crumbs, scope);
  if (id === LOCAL_PAGE && s.list !== undefined) return localPage(r, s, crumbs, scope);
  if (id === COLOURS_PAGE && s.list !== undefined && s.colours?.data !== undefined)
    return coloursPage(r, s, crumbs, scope);
  if (id === 'problems') {
    const ps = problemRows(s);
    const rows: Node[] = ps.map((p, i) => problemNode(s, p, i));
    const count = problemCount(s);

    return page(
      [`Problems · ${count}`],
      scope,
      [
        ...rows,
        {
          kind: 'SettingsNote',
          props: { text: count === 0 ? 'No problems' : 'No other problems' },
        },
      ],
      s.row,
    );
  }
  if (s.list === undefined && s.down !== undefined)
    return page(
      crumbs,
      scope,
      [
        {
          kind: 'SettingsEmpty',
          props: {
            title: `${s.down} · Settings read when it is back`,
            action: { id: 'settings:retry', label: 'Retry' },
          },
        },
      ],
      s.row,
    );
  // the rows once read, never drawn unchecked then flipped as the values land (#297)
  if (s.list === undefined && s.down === undefined)
    return page(crumbs, scope, [empty(READING)], s.row);
  const ls = settingLines(pageLines(r, s, id));

  if (ls.length === 0)
    return page(crumbs, scope, [empty(catalogue.empty ?? 'Nothing to set here yet')], s.row);

  return page(
    crumbs,
    scope,
    grouped(r, s, ls, 0, (row) => row.group),
    s.row,
  );
};

export const empty = (title: string, line?: string): Node => ({
  kind: 'SettingsEmpty',
  props: { title, ...(line === undefined ? {} : { line }) },
});

export const page = (crumbs: string[], scope: string, children: Node[], row: number): Node => {
  const reveal = revealOf(children, row);

  return {
    kind: 'SettingsPage',
    id: 'settings:page',
    props: { crumbs, scope, ...(reveal === undefined ? {} : { reveal }) },
    children,
  };
};

const pagesChanged = (r: SettingsDialogRules, s: SettingsState): Set<string> => {
  const rows = new Set(Object.keys(s.changes));
  const out = new Set<string>();
  const walk = (nodes: readonly TreeNode[]) => {
    for (const n of nodes) {
      if (n.page !== null && r.page(n.page).rows.some((row) => rows.has(row.id))) out.add(n.id);
      walk(n.children);
    }
  };

  walk(r.tree);

  return out;
};

/**
 * A tree row's count: Problems' warn one (dim with info rows only, #168), a search's hits, else a
 * page's problems.
 */
const countOf = (
  isProblems: boolean,
  problems: { count: number; rows: number },
  searched: boolean,
  hits: number | undefined,
  pageProblems: number,
): SettingsTreeRow['count'] => {
  if (isProblems)
    return problems.count > 0
      ? { text: `· ${problems.count}`, tone: 'warn' }
      : { text: `· ${problems.rows}`, tone: 'dim' };
  if (searched) return hits === undefined ? undefined : { text: String(hits), tone: 'dim' };

  return pageProblems > 0 ? { text: String(pageProblems), tone: 'dim' } : undefined;
};

const treeNode = (r: SettingsDialogRules, s: SettingsState): Node => {
  const q = searching(s);
  const counts = q === undefined ? undefined : hitsOf(r, s, q).counts;
  const problems = problemsOnly(problemRows(s));
  const modified = pagesChanged(r, s);
  const rows = visible(r, s).map(({ node, depth }): SettingsTreeRow => {
    const kids = node.children.length > 0;
    const page = node.page;
    const hits = counts === undefined || page === null ? undefined : counts[page];
    const pageProblems =
      page === null || page === 'problems' ? 0 : problems.filter((p) => p.page === page).length;
    const count = countOf(
      node.id === 'problems',
      { count: problems.length, rows: problemRows(s).length },
      counts !== undefined,
      hits,
      pageProblems,
    );

    return {
      id: `settings:tree:${node.id}`,
      label: node.label,
      depth,
      ...(kids
        ? { fold: s.folded.includes(node.id) ? ('closed' as const) : ('open' as const) }
        : {}),
      ...(count === undefined ? {} : { count }),
      ...((results(s) === undefined || s.focus === 'tree') && node.id === s.node && !held(s)
        ? { selected: true }
        : {}),
      ...(counts !== undefined && !hasHits(node, counts) ? { dim: true } : {}),
      ...(modified.has(node.id) ? { modified: true } : {}),
      ...(node.id === 'problems' ? { separator: true } : {}),
    };
  });

  return { kind: 'SettingsTree', id: 'settings:tree', props: { nodes: rows } };
};

const noteOf = (s: SettingsState): { note: string; noteTone?: SettingsTone } => {
  const writing = Object.keys(s.writing).length;
  // a field's reason said as it is typed is that field's, not a change refused
  const typing = editingOf(s)?.row;
  const errors = Object.keys(s.errors).filter((row) => row !== typing).length;
  const last = s.undo.at(-1);

  if (writing > 0) return { note: `Saving ${plural(writing, 'change')}…` };
  if (errors > 0)
    return {
      note: `${plural(errors, 'change')} refused, nothing saved · see the rows`,
      noteTone: 'bad',
    };
  if (s.down !== undefined && s.list !== undefined)
    return { note: `${s.down} · Settings read when it is back`, noteTone: 'warn' };
  if (last !== undefined) return { note: `Saved ${last.label} · ⌘Z undoes` };

  return { note: 'Each change saves as you make it; ⌘⏎ proposes one for the repo' };
};

export const view = (r: SettingsDialogRules, s: SettingsState): Node | undefined => {
  if (!s.open) return undefined;
  const p = proposingOf(s);
  const ask = p === undefined ? [] : [proposeNode(r, s, p)];
  const fix = fixNode(s);

  return {
    kind: 'SettingsDialog',
    id: 'settings',
    props: {
      title: 'Settings',
      search: { text: s.search ?? '' },
      ...noteOf(s),
      focus: s.focus,
      ...(s.all ? { selectAll: true } : {}),
      ...(s.undo.length > 0 ? { undo: { id: 'settings:undo', label: 'Undo' } } : {}),
    },
    children: [treeNode(r, s), pageNode(r, s), ...(fix === undefined ? [] : [fix]), ...ask],
  };
};
