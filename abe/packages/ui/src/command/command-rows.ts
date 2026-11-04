/**
 * Command mode's rows (#346): what the `:` line lists and which row ⏎ takes, from where it was
 * opened (`HereInput`: the Subject, the view's rows, the Editor's Ex commands) and what is typed.
 * Pure: `command.ts` keys and draws them.
 *
 * Groups, in order: your words (only while something is typed: Run in Neovim in the Editor, `Ask
 * about <subject>`, `New card “<words>”` where a board is in force, `Tell <who>'s session`), the Subject's actions (its ⌘⏎ rows that can run, at
 * most `SUBJECT_ROWS`, then `All … actions…`), the view's own rows, Anywhere, and More (every
 * other matching row of the command table, the screens' words and your personal commands: only
 * once typed). `:` lists only rows that can run; ⌘⏎ keeps the grey ones with their reason. The
 * Ask, New card and Tell rows alone are grey while serve does not answer.
 *
 * The row ⏎ takes (`resting`): nothing typed, the Subject's next step (the first row that can run
 * and spends nothing, `restingCursor`); a trailing `?`, Ask; in the Editor, text Neovim takes as
 * an Ex command and no row's exact name (nor a word that takes text, typed with it: `new <title>`),
 * Run in Neovim; one word, the best matching row (Ask
 * second); a sentence, Ask, unless its first words name a command that takes text (`show cart`,
 * `improve hide the Done lane`, `card show 4`) or it is the start of a row's name (`card sh`).
 */
import type { HelpData } from '@abe/core';
import { isExCommand } from './ex';
import {
  type HereInput,
  type Menu,
  type MenuAsk,
  type MenuRow,
  type StripeGo,
  type Word,
} from '../runtime/runtime';

/** One row of the table, a screen's word or a personal command (`More`). */
export type Entry = {
  id: string;
  /** As typed after `abe` (`card move`), or the word. */
  name: string;
  summary: string;
  /** Its words and fixed arguments, before the asked ones. */
  argv: readonly string[];
  /** The required arguments, asked in order. */
  ask: readonly MenuAsk[];
  risky: boolean;
  /** A screen's word: what choosing it does instead of a run (given its asked values). */
  commands?: Word['commands'] | undefined;
  /** A screen's `confirm`: its own question, lines and yes, in place of `Run …?`. */
  asks?:
    | {
        question: string;
        details: readonly string[];
        yes: string;
        no?: string | undefined;
        danger?: boolean | undefined;
      }
    | undefined;
  /** `abe improve`: its wish typed after it (`:improve hide the Done lane`), said to the Abe chat. */
  improve?: true | undefined;
  /** The status line once it went through, in place of the CLI's answer (#204), given the values. */
  done?: string | ((values: readonly string[]) => string) | undefined;
  /** A screen's row or confirm, not typed: its answer is said without the `abe …` it ran. */
  chosen?: true | undefined;
};

const nameOf = (c: { noun: string; verb: string | null }) =>
  c.verb === null ? c.noun : `${c.noun} ${c.verb}`;

/** Every entry, in order: the screens' words, the table's commands, your own. */
export const entries = (help: HelpData, words: readonly Word[]): Entry[] => [
  ...words.map((w): Entry => ({
    id: `word:${w.word}`,
    name: w.word,
    summary: w.summary,
    argv: [],
    ask: w.ask ?? [],
    risky: false,
    commands: w.commands,
  })),
  ...help.commands
    // a screen's word in its place (`:triage` opens the overview's table, #77)
    .filter((c) => c.only === null && !words.some((w) => w.word === nameOf(c)))
    .map((c): Entry => {
      const name = nameOf(c);

      return {
        id: `command:${name}`,
        name,
        summary: c.summary,
        argv: name.split(' '),
        ask: c.args.filter((a) => a.required),
        risky: c.risky,
        ...(name === 'improve' ? { improve: true as const } : {}),
      };
    }),
  ...(help.personal ?? []).flatMap((p): Entry[] => {
    // the table's command it runs: the longest whose words lead its argv
    const runs = help.commands
      .filter((c) =>
        (c.verb === null ? [c.noun] : [c.noun, ...c.verb.split(' ')]).every(
          (w, i) => p.argv[i] === w,
        ),
      )
      .sort((a, b) => (b.verb?.length ?? 0) - (a.verb?.length ?? 0))[0];

    // one a session's own or the client's is not listed, as the table's are not
    if (runs?.only !== null) return [];

    return [
      {
        id: `personal:${p.name}`,
        name: p.name,
        summary: p.summary ?? `abe ${p.argv.join(' ')}`,
        argv: p.argv,
        ask: [],
        risky: runs.risky,
      },
    ];
  }),
];

const isSubsequence = (needle: string, hay: string): boolean => {
  let at = 0;

  for (const ch of hay) if (ch === needle[at]) at += 1;

  return at === needle.length;
};

/**
 * How well `text` (a row's name, then its summary) matches the filter: the whole name first (so
 * `improve` runs `:improve`, never a word that starts with it, #295), then a prefix of the name,
 * then the name holding it, then its letters in order (`crd mve` finds `card move`), then the
 * summary; `undefined`: no match.
 */
export const matchScore = (name: string, summary: string, filter: string): number | undefined => {
  const f = filter.trim().toLowerCase();

  if (f === '') return 0;
  const n = name.toLowerCase().replace(/…$/, '');

  if (n === f) return 0;
  if (n.startsWith(f)) return 1;
  if (n.includes(f)) return 2;
  if (isSubsequence(f.replaceAll(' ', ''), n.replaceAll(' ', ''))) return 3;
  if (summary.toLowerCase().includes(f)) return 4;

  return undefined;
};

/** The items matching `filter`, best first, their order within one score. */
export const filtered = <T>(
  items: readonly T[],
  filter: string,
  words: (t: T) => [string, string],
): T[] =>
  items
    .map((item, i) => ({ item, i, score: matchScore(...words(item), filter) }))
    .filter((m): m is { item: T; i: number; score: number } => m.score !== undefined)
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((m) => m.item);

/**
 * What follows an entry's name in the filter when it takes that text whole (`show cart` →
 * `cart`, `improve hide it` → `hide it`): a word or `improve` of one argument; else undefined.
 */
export const typedAfter = (e: Entry, filter: string): string | undefined => {
  if ((e.commands === undefined && e.improve !== true) || e.ask.length !== 1) return undefined;
  const f = filter.trimStart();

  return f.toLowerCase().startsWith(`${e.name.toLowerCase()} `)
    ? f.slice(e.name.length).trim()
    : undefined;
};

/**
 * The entry the filter's first words name, when it takes the rest as text (`show cart`, `card
 * show 4`) or is the whole filter (`card list`): the longest such name; else undefined.
 */
export const namedEntry = (all: readonly Entry[], filter: string): Entry | undefined => {
  const f = filter.trim().toLowerCase();

  return all
    .filter((e) => {
      const n = e.name.toLowerCase();

      return n === f || (f.startsWith(`${n} `) && (e.ask.length > 0 || e.improve === true));
    })
    .sort((a, b) => b.name.length - a.name.length)[0];
};

/** The Subject group's most rows (#346); the rest are its ⌘⏎ menu's (`All … actions…`). */
export const SUBJECT_ROWS = 6;

/** What choosing a row does. */
export type RowDoes =
  | { kind: 'entry'; entry: Entry }
  /** A menu's row (the Subject's, the view's, Anywhere's), chosen as ⌘⏎'s would be. */
  | { kind: 'row'; menu: Menu; row: MenuRow }
  /** `abe chat <words> (about <the Subject>)`: said to the Abe chat. */
  | { kind: 'ask'; words: string }
  /** The New card dialog on the words as its title (#346): where a board is in force. */
  | { kind: 'new'; words: string }
  /** `abe session send <id> <words>`: told to the Subject's live session. */
  | { kind: 'tell'; words: string; session: string; card?: number | undefined }
  /** The text as Neovim's own command line would run it. */
  | { kind: 'ex'; text: string }
  /** The Subject's whole Action menu (⌘⏎'s, grey rows too). */
  | { kind: 'all'; menu: Menu }
  /** The key help of where `:` was opened. */
  | { kind: 'keys' };

export type Row = {
  id: string;
  text: string;
  dim?: string | undefined;
  /** A key it has, dim at the right. */
  note?: string | undefined;
  /** Grey: why it cannot run (only the Ask row, while serve does not answer). */
  reason?: string | undefined;
  /** The group's dim heading, drawn above its first row. */
  section?: string | undefined;
  risky?: boolean | undefined;
  /** It spends or asks first: never where ⏎ rests unasked (#313). */
  costly?: boolean | undefined;
  does: RowDoes;
};

/** What the rows are built from. */
export type RowsFrom = {
  here: HereInput | undefined;
  /** The table's rows, once `abe help` answered (none before). */
  entries: readonly Entry[];
  /** Anywhere's rows (Search Everywhere, Settings, …). */
  anywhere: readonly Row[];
  filter: string;
};

/** Why the Ask row is grey while serve does not answer. */
export const SERVE_DOWN = 'abe serve not answering';

const menuRowOf = (menu: Menu, r: MenuRow, prefix: string): Row => ({
  id: `${prefix}:${r.id}`,
  text: r.text,
  ...(r.dim === undefined ? {} : { dim: r.dim }),
  ...(r.key === undefined ? {} : { note: r.key }),
  ...(r.risky === true ? { risky: true } : {}),
  ...(spends(r) ? { costly: true } : {}),
  does: { kind: 'row', menu, row: r },
});

/** A row ⏎ should not reach unasked: it spends, deletes, or asks yes / no first (#313, #278). */
const spends = (row: MenuRow): boolean =>
  row.costly === true ||
  row.risky === true ||
  ((row.does.kind === 'run' || row.does.kind === 'back') && row.does.confirm !== undefined) ||
  (row.does.kind === 'run' && row.does.risky === true);

const entryRow = (e: Entry): Row => ({
  id: e.id,
  text: e.name,
  dim: e.summary,
  ...(e.risky ? { costly: true } : {}),
  does: { kind: 'entry', entry: e },
});

/** The first of `rows` gets the group's heading. */
const headed = (title: string, rows: readonly Row[]): Row[] =>
  rows.map((r, i) => (i === 0 ? { ...r, section: title } : r));

const matching = (rows: readonly Row[], filter: string): Row[] =>
  filtered(rows, filter, (r) => [r.text, r.dim ?? '']);

/** A group of rows under its dim heading. */
type Group = { title: string; rows: Row[] };

/** The Subject's rows: its menu's that can run (next step first), then its whole menu. */
const subjectGroup = (here: HereInput, filter: string): Group[] => {
  const s = here.here.subject;

  if (s?.menu === undefined) return [];
  const menu = s.menu;
  const runnable = menu.rows.filter((r) => r.reason === undefined);
  const shown = matching(
    runnable.map((r) => menuRowOf(menu, r, 'subject')),
    filter,
  ).slice(0, SUBJECT_ROWS);
  const all: Row[] =
    shown.length < menu.rows.length
      ? matching(
          [
            {
              id: 'subject:all',
              text: `All ${s.label} actions…`,
              note: '⌘⏎',
              does: { kind: 'all', menu },
            },
          ],
          filter,
        )
      : [];

  return [{ title: s.caption, rows: [...shown, ...all] }];
};

/** The view's rows that can run, then `extra` (the install's), under the view's heading. */
const viewGroup = (here: HereInput, filter: string, extra: readonly Row[]): Group[] => {
  const v = here.here.view;
  const own =
    v === undefined
      ? []
      : v.menu.rows.filter((r) => r.reason === undefined).map((r) => menuRowOf(v.menu, r, 'view'));
  const rows = matching([...own, ...extra], filter);

  if (rows.length === 0) return [];

  return [{ title: v?.title ?? here.project ?? 'Here', rows }];
};

/** Why a workspace's stripe item is grey on the Board (#20's menu says the same). */
export const ONLY_IN_A_WORKSPACE = 'Only in a workspace';

/** Go to's rows hand their choice to the shell, never to a screen. */
const GO_MENU: Menu = { kind: 'menu', id: 'go', title: 'Go to', rows: [] };

/** Whether the place is a workspace's (the code, or its Run): Run, Terminal and Git open (#20). */
const inWorkspace = (place: string | undefined) => place === 'project' || place === 'run';

/**
 * Go to (#11): the stripe's items, once typed (the stripe is on screen already), the place you
 * are in left out, a name already listed not again; a workspace's grey elsewhere, with why.
 */
const goGroup = (here: HereInput, filter: string, listed: ReadonlySet<string>): Group[] => {
  if (filter === '' || here.stripe === undefined) return [];
  const rows = here.stripe
    .filter((i) => i.id !== here.place && !listed.has(plain(i.label)))
    .map((i): Row => {
      const row: MenuRow = {
        id: i.id,
        text: i.label,
        does: { kind: 'shell', effect: { kind: 'stripe-open', id: i.id } },
      };

      const where = goWhere(i);

      return {
        id: `go:${i.id}`,
        text: i.label,
        dim: where.dim,
        ...(where.key === undefined ? {} : { note: where.key }),
        ...(i.workspaceOnly === true && !inWorkspace(here.place)
          ? { reason: ONLY_IN_A_WORKSPACE }
          : {}),
        does: { kind: 'row', menu: GO_MENU, row },
      };
    });
  const shown = matching(rows, filter);

  return shown.length === 0 ? [] : [{ title: 'Go to', rows: shown }];
};

/**
 * Where Go to's items are since the rail, and their key (the stripe's own words are from before
 * it: the bottom pane, ⌘5–⌘7): a workspace's pages, the rail's places, Code's bottom panel.
 */
const GO_WHERE: Readonly<Record<string, { dim: string; key: string | undefined }>> = {
  project: { dim: 'the Code page', key: '⌃1' },
  run: { dim: 'a page', key: '⌃2' },
  board: { dim: 'on the rail', key: '⌘⌥A' },
  sessions: { dim: 'a tab: Mine · Team · Sessions', key: undefined },
  boxes: { dim: 'on the rail', key: undefined },
  pipelines: { dim: 'on the rail', key: undefined },
  terminal: { dim: 'in Code’s bottom panel', key: '⌃`' },
  git: { dim: 'in Code’s bottom panel', key: '⌘3' },
};

const goWhere = (i: StripeGo): { dim: string; key: string | undefined } =>
  GO_WHERE[i.id] ?? {
    dim: i.group === 'top' ? 'a place' : 'in Code’s bottom panel',
    key: i.key,
  };

/** Why the Factory install's row is grey in a worktree (#11, #22: it runs in the main checkout). */
export const NOT_MAIN_CHECKOUT = "only in the repo's main checkout";

/**
 * The Factory install's row (#11, #22), on the Board and in the Editor by the shown checkout: a
 * main one not installed lists `Install the Factory…`; installed, `Install again…` once typed; a
 * worktree, grey once typed. `typed`: listed only once something is typed.
 */
const installRow = (
  here: HereInput,
  all: readonly Entry[],
): { row: Row; typed: boolean; entry: Entry } | undefined => {
  const c = here.checkout;
  const entry = all.find((e) => e.name === 'install');
  const keys = here.here.keys ?? 'view';

  if (c === undefined || entry === undefined || (keys !== 'view' && keys !== 'editor'))
    return undefined;
  const does: RowDoes = { kind: 'entry', entry };
  const id = 'here:install';

  if (!c.main)
    return {
      entry,
      typed: true,
      row: { id, text: 'Install Abe…', reason: NOT_MAIN_CHECKOUT, does },
    };

  return c.installed
    ? {
        entry,
        typed: true,
        row: { id, text: 'Install again…', dim: 'fix only what is stale', does },
      }
    : {
        entry,
        typed: false,
        row: {
          id,
          text: 'Install Abe…',
          dim: 'set this repo up: one session, one pull request',
          does,
        },
      };
};

/** The groups' rows, each group's first under its heading, `without` left out. */
const grouped = (groups: readonly Group[], without?: string): Row[] =>
  groups.flatMap((g) =>
    headed(
      g.title,
      g.rows.filter((r) => r.id !== without),
    ),
  );

/** The Ask row's words when ⏎ does not ask: a word or two that names no command. */
export const NO_COMMAND = 'no command · ? to ask';

/** Your words: Run in Neovim, Ask about …, Tell …'s session. */
const yourWords = (here: HereInput | undefined, typed: string): Row[] => {
  const s = here?.here.subject;
  const about = s?.label ?? here?.project;
  const ex =
    here?.ex !== undefined && isExCommand(typed, here.ex)
      ? [
          {
            id: 'here:ex',
            text: 'Run in Neovim',
            dim: `:${typed}`,
            does: { kind: 'ex' as const, text: typed },
          },
        ]
      : [];
  const ask: Row = {
    id: 'here:ask',
    text: about === undefined ? 'Ask' : `Ask about ${about}`,
    dim: 'the Abe chat',
    ...(here?.serving === false ? { reason: SERVE_DOWN } : {}),
    does: { kind: 'ask', words: typed },
  };
  const tell =
    s?.tell === undefined
      ? []
      : [
          {
            id: 'here:tell',
            text: `Tell ${s.tell.whose}’s session`,
            dim: s.tell.dim,
            ...(here?.serving === false ? { reason: SERVE_DOWN } : {}),
            does: {
              kind: 'tell' as const,
              words: typed,
              session: s.tell.session,
              card: s.tell.card,
            },
          },
        ];

  const fresh: Row[] =
    here?.here.board === true
      ? [
          {
            id: 'here:new',
            text: `New card “${clipped(typed)}”`,
            note: '⌘⏎',
            ...(here.serving ? {} : { reason: SERVE_DOWN }),
            does: { kind: 'new', words: typed },
          },
        ]
      : [];

  return [...ex, ask, ...fresh, ...tell];
};

/** How much of the words a row names (`New card “why does the cart total ignore…”`). */
const ROW_WORDS = 32;

const clipped = (text: string): string => {
  const cs = Array.from(text);

  return cs.length <= ROW_WORDS
    ? text
    : `${cs
        .slice(0, ROW_WORDS - 1)
        .join('')
        .trimEnd()}…`;
};

const plain = (text: string) => text.toLowerCase().replace(/…$/, '').trim();

/** The rows the line lists now, and where ⏎ rests (-1: nowhere, every row spends). */
export const commandRows = (o: RowsFrom): { rows: Row[]; resting: number } => {
  const typed = o.filter.trim();
  const here = o.here;
  const install = here === undefined ? undefined : installRow(here, o.entries);
  // the install's row in the table's place: never listed twice, never run where it can't
  const table = install === undefined ? o.entries : o.entries.filter((e) => e !== install.entry);
  const groups = (filter: string): Group[] => [
    ...(here === undefined ? [] : subjectGroup(here, filter)),
    ...(here === undefined
      ? []
      : viewGroup(
          here,
          filter,
          install === undefined || (install.typed && filter === '') ? [] : [install.row],
        )),
    { title: 'Anywhere', rows: matching(o.anywhere, filter) },
  ];
  // Go to after the view's, a name the groups list not again (the Board's `Prototype…`)
  const withGo = (filter: string): Group[] => {
    const gs = groups(filter);
    const listed = new Set(gs.flatMap((g) => g.rows.map((r) => plain(r.text))));
    const go = here === undefined ? [] : goGroup(here, filter, listed);

    return [...gs.slice(0, -1), ...go, ...gs.slice(-1)];
  };

  if (typed === '') {
    const rows = grouped(groups(''));

    return { rows, resting: rows.findIndex((r) => r.costly !== true && r.reason === undefined) };
  }
  // a trailing `?` asks; what it follows still finds its rows
  const bare = typed.replace(/\?+$/, '').trim();
  const shown = withGo(bare);
  const listed = shown.flatMap((g) => g.rows);
  const taken = new Set(listed.map((r) => plain(r.text)));
  const given = namedEntry(table, bare);
  const more = matching(
    table.filter((e) => e !== given && !taken.has(plain(e.name))).map(entryRow),
    bare,
  );
  const words = yourWords(here, typed);
  const ex = words.find((r) => r.does.kind === 'ex');
  const ask = words.find((r) => r.does.kind === 'ask');
  const usable = (r: Row | undefined): r is Row => r !== undefined && r.reason === undefined;
  const exact = [...listed, ...more, ...(given === undefined ? [] : [entryRow(given)])].some(
    (r) => plain(r.text) === plain(typed),
  );
  const sentence = typed.split(/\s+/).length > 1;
  // a sentence is an ask unless it is the start of a row's name (`card sh`, `triage te`)
  const starts = (r: Row) => (matchScore(r.text, '', typed) ?? 5) <= 1;
  // a named command, else the best match of all (by score, then group order)
  const best =
    (given === undefined ? undefined : entryRow(given)) ??
    matching([...listed, ...more], bare).find((r) => !sentence || starts(r));
  const question = typed.endsWith('?');
  // a word that takes text, typed with it, beats Ex (`new Customers can save`, not `:new`)
  const takes = given !== undefined && (typedAfter(given, bare) ?? '') !== '';
  const neovim = ex !== undefined && !exact && !takes;
  // what is put first, above your words: the command ⏎ takes, when it is one
  const lead = question || neovim ? undefined : best;
  // the named command stays listed when ⏎ goes elsewhere (`status?`), first of More
  const named = given === undefined ? [] : [entryRow(given)];
  const rest = grouped([...shown, { title: 'More', rows: [...named, ...more] }], lead?.id);
  // a word or two that names nothing (`bufdo w`, a typo): an Ask is a paid session, so ⏎ starts
  // none; `?` (or the Ask row itself) asks
  const unnamed = !question && !neovim && lead === undefined && typed.split(/\s+/).length < 3;
  const said = unnamed
    ? words.map((r) => (r.does.kind === 'ask' ? { ...r, dim: NO_COMMAND } : r))
    : words;
  const rows = lead === undefined ? [...said, ...rest] : [lead, ...said, ...rest];

  if (unnamed) return { rows, resting: -1 };
  const typedTarget = neovim ? ex : (lead ?? ask);
  const target = question ? ask : typedTarget;
  // a command named that can't run here (`install` in a worktree): ⏎ takes nothing, says why
  if (lead?.reason !== undefined && target === lead) return { rows, resting: -1 };
  const resting = usable(target)
    ? rows.findIndex((r) => r.id === target.id)
    : rows.findIndex((r) => usable(r));

  return { rows, resting };
};
