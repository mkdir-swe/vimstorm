/**
 * Settings › Logins & tools (S6, S-Logins; #345 split of `settings.ts`): its two reads, its rows
 * drawn at once as `checking…`, the fix strip.
 */
import {
  type CheckItem,
  type SettingsDialogRules,
  type SettingsProblem,
  type SourcesData,
  type ToolsCheckData,
} from '@abe/core';
import { type Node } from '../runtime/components';
import { type Answer, type Refused } from '../runtime/runtime';
import {
  type CheckRow,
  type SettingsFix,
  type SettingsGroup,
  type SettingsTone,
} from './settings-components';
import { readThemes } from './settings-colours';
import { readLocal } from './settings-local';
import { readProfiles } from './settings-profiles';
import {
  type Line,
  boardNotAzure,
  focusedLine,
  pageLines,
  read,
  results,
  without,
} from './settings-rows';
import {
  type CheckRead,
  type Checks,
  type Fix,
  LOCAL_PAGE,
  LOGINS_PAGE,
  type Out,
  PROFILES_PAGE,
  type SettingsState,
  THEME_PAGES,
  same,
  status,
  downOf,
} from './settings-state';
import { pageShown } from './settings-tree';
import { captionOf, empty, page } from './settings-view';

/** How the screen names `where` (the value stays as serve sends it; core's CLI says the same). */
const TOOLS_WHERE_WORDS: Readonly<Record<ToolsCheckData['where'], string>> = {
  'this Mac': 'this machine',
  'this box': 'this box',
};

/**
 * The three reads, once per open, while Logins & tools shows (never in the background; a
 * source's sign-in ending is told, `sources.changed`); `fresh` (a fix ended): the last answers
 * dropped, so each row says `checking…` until its read lands.
 */
const readChecks = (s: SettingsState, fresh = false): Out => {
  const runs = s.runs + 3;
  const checks: Checks = {
    logins: fresh ? undefined : s.checks?.logins,
    tools: fresh ? undefined : s.checks?.tools,
    sources: fresh ? undefined : s.checks?.sources,
    reading: ['login status', 'tools check', 'source status'],
    where: s.checks?.tools?.where ?? s.checks?.where,
  };

  return {
    state: { ...s, runs, checks },
    commands: [
      { kind: 'run', id: `settings:checks:${runs - 2}`, argv: ['login', 'status'] },
      { kind: 'run', id: `settings:checks:${runs - 1}`, argv: ['tools', 'check'] },
      { kind: 'run', id: `settings:checks:${runs}`, argv: ['source', 'status'] },
    ],
  };
};

/**
 * ⏎ on a source's row (ADR 0028): serve signs it in, in your browser, outside any sandbox (`abe
 * source sign-in`); its row says Signing in… once serve answers, then how it ended.
 */
const signIn = (s: SettingsState, item: CheckItem): Out => {
  const runs = s.runs + 1;
  const source = item.id.slice('source:'.length);

  return {
    state: { ...s, runs },
    commands: [
      status(`${item.label}: signing in, in your browser`),
      { kind: 'run', id: `settings:checks:${runs}`, argv: ['source', 'sign-in', source] },
    ],
  };
};

/** A source's sign-in started or ended (`sources.changed`): its checkout's rows, as shown. */
export const sourcesChanged = (s: SettingsState, data: SourcesData): Out =>
  s.checks?.sources?.repo !== data.repo
    ? same(s)
    : same({ ...s, checks: { ...s.checks, sources: data } });

/** A page's own reads not asked this open: Logins & tools' checks, Browser profiles' list. */
const pageReads = (r: SettingsDialogRules, s: SettingsState): Out | undefined => {
  const shown = pageShown(r, s);

  if (shown === LOGINS_PAGE && (s.checks === undefined || s.checks.stale === true))
    return readChecks(s);
  if (shown === PROFILES_PAGE && s.profiles === undefined) return readProfiles(s);
  if (shown === LOCAL_PAGE && s.local === undefined) return readLocal(s);
  if (THEME_PAGES.has(shown) && s.themes === undefined) return readThemes(s);

  return undefined;
};

/** After a step: the page shown reads what it needs, once per open (never in the background). */
export const checksDue = (r: SettingsDialogRules, out: Out): Out => {
  const s = out.state;

  if (!s.open) return out;
  // a search reads the themes (#345): Scheme's words, and the Colours tokens it finds once the
  // themes name the one Colours edit
  const themed = s.themes === undefined && results(s) !== undefined;
  const shown = results(s) === undefined ? pageReads(r, s) : undefined;
  const read = shown ?? (themed ? readThemes(s) : undefined);

  if (read === undefined) return out;

  return { state: read.state, commands: [...out.commands, ...read.commands] };
};

/** ⏎ on a check: its fix typed into the strip; ⏎ again on it runs it. An OK row says so. */
export const checkPressed = (s: SettingsState, item: CheckItem): Out => {
  if (item.checking) return { state: s, commands: [status(`${item.label}: ${item.state}`)] };
  if (item.signIn !== null && item.signIn !== undefined) return signIn(s, item);
  if (item.ok) return { state: s, commands: [status(`${item.label}: ✓ OK`)] };
  if (item.fix === null)
    return { state: s, commands: [status(`${item.label}: no fix here (${item.check})`)] };
  const f = s.fix;

  if (f?.item === item.id && f.state === 'queued') return runFix(s, f);
  if (f?.state === 'running')
    return { state: s, commands: [status(`A fix is running: ${f.command}`)] };

  return same({
    ...s,
    fix: { item: item.id, label: item.label, command: item.fix, state: 'queued' },
  });
};

export const runFix = (s: SettingsState, f: Fix): Out => {
  const runs = s.runs + 1;

  return same({ ...s, runs, fix: { ...f, state: 'running', key: `settings-fix:${runs}` } });
};

/** The strip dropped (Esc): a running fix's terminal let go at once. */
export const dropFix = (s: SettingsState): Out => {
  const key = s.fix?.key;

  return {
    state: { ...s, fix: undefined },
    commands: key === undefined ? [] : [{ kind: 'shell', effect: { kind: 'drop-terminal', key } }],
  };
};

/** A fix's program ended: the strip says so and the checks and Problems run again. */
export const fixEnded = (s: SettingsState, key: string, code: number | null): Out => {
  if (s.fix?.key !== key) return same(s);
  const ended: SettingsState = { ...s, fix: { ...s.fix, state: 'ended', exit: code } };
  const checks = readChecks(ended, true);
  const problems = read(checks.state, 'problems');

  return { state: problems.state, commands: [...checks.commands, ...problems.commands] };
};

/** A check's answer: kept, or the page says serve is down. */
export const checked = (s: SettingsState, input: Answer | Refused): Out => {
  const c = s.checks ?? {};

  // a source's sign-in: started, its rows as serve has them now; refused, said
  if (input.command === 'source sign-in')
    return input.reply.ok
      ? sourcesChanged(s, input.reply.data)
      : { state: s, commands: [status(input.reply.error.message)] };
  const command: CheckRead =
    input.command === 'login status' || input.command === 'source status'
      ? input.command
      : 'tools check';
  const refused = without(c.refused ?? {}, command);
  const had = { ...c, reading: (c.reading ?? []).filter((r) => r !== input.command), refused };

  if (!input.reply.ok) {
    const why = downOf(input.reply.error);
    // serve not answering is the page's; any other refusal is its read's rows' alone
    const down = input.reply.error.code === 'serve-unreachable' ? why : c.down;

    return same({ ...s, checks: { ...had, down, refused: { ...refused, [command]: why } } });
  }
  if (input.command === 'login status')
    return same({ ...s, checks: { ...had, logins: input.reply.data, down: undefined } });
  if (input.command === 'tools check')
    return same({ ...s, checks: { ...had, tools: input.reply.data, down: undefined } });
  if (input.command === 'source status')
    return same({ ...s, checks: { ...had, sources: input.reply.data, down: undefined } });

  return same(s);
};

/**
 * Logins & tools' rows (#345): drawn at once, a read under way's rows saying `checking…` until
 * its answer fills them in place (never Tools then Logins inserted above them, #297); the last
 * open's answers while it reads them again. None while serve is down and nothing was read.
 */
export const checksShown = (
  s: SettingsState,
): Parameters<SettingsDialogRules['checks']>[0] | undefined => {
  const c = s.checks;

  if (c === undefined) return undefined;
  if (c.down !== undefined && c.logins === undefined && c.tools === undefined) return undefined;
  const reading = c.reading ?? [];

  return {
    logins: c.logins,
    tools: c.tools,
    sources: c.sources,
    azure: !boardNotAzure(s),
    checking: {
      logins: reading.includes('login status'),
      tools: reading.includes('tools check'),
      sources: reading.includes('source status'),
    },
    refused: {
      logins: c.refused?.['login status'],
      tools: c.refused?.['tools check'],
      sources: c.refused?.['source status'],
    },
  };
};

/** A check's state colour: dim while checking or signing in, warn when a problem, else plain. */
const checkTone = (item: CheckItem): { tone?: 'dim' | 'warn' } => {
  // a sign-in serve runs is under way too, no problem yet
  if (item.checking || item.signIn === 'signing-in') return { tone: 'dim' };

  return item.ok || item.optional ? {} : { tone: 'warn' };
};

const checkNode = (
  item: CheckItem,
  at: number,
  focused: boolean,
  fix: Fix | undefined,
): CheckRow => {
  const queued = fix?.item === item.id && fix.state === 'queued';

  return {
    kind: 'CheckRow',
    id: `settings:line:${at}`,
    props: {
      label: item.label,
      ...(item.value === null ? {} : { value: item.value }),
      check: item.check,
      state: { text: item.state, ...checkTone(item) },
      ...(item.fix === null ? {} : { way: queued ? 'queued · ⏎ runs it' : 'fix…' }),
      ...(item.signIn === 'offered' ? { way: 'Sign in…' } : {}),
      ...(item.signIn === 'signing-in' ? { way: 'Sign in again…' } : {}),
      ...(focused ? { focused: true } : {}),
    },
  };
};

/** Logins & tools' page: the Logins and Tools groups, or why they are not read. */
export const loginsPage = (r: SettingsDialogRules, s: SettingsState, crumbs: string[]): Node => {
  const ls = pageLines(r, s, LOGINS_PAGE).flatMap((l) => (l.kind === 'check' ? [l.item] : []));
  const where = TOOLS_WHERE_WORDS[s.checks?.tools?.where ?? s.checks?.where ?? 'this Mac'];
  const reading = (s.checks?.reading ?? []).length > 0;
  const had = s.checks?.logins !== undefined || s.checks?.tools !== undefined;
  const down = s.checks?.down;
  const scope = ((): string => {
    // the last open's rows while serve is down: said as such, never as checked now
    if (down !== undefined && had) return `${where} · ${down} · as last checked`;
    if (reading) return `${where} · ${had ? 'checking again…' : 'checking…'}`;

    return `${where} · checked when Settings opens`;
  })();

  if (ls.length === 0)
    return page(
      crumbs,
      scope,
      [
        s.checks?.down === undefined
          ? empty('Checking logins and tools…')
          : {
              kind: 'SettingsEmpty',
              props: {
                title: `${s.checks.down} · Logins & tools read when it is back`,
                action: { id: 'settings:retry', label: 'Retry' },
              },
            },
      ],
      s.row,
    );
  const focusedAt = s.focus === 'page' ? s.row : -1;
  const groups = (['Logins', 'Sources', 'Tools'] as const).flatMap((g): SettingsGroup[] => {
    const rows = ls
      .map((item, at) => ({ item, at }))
      .filter((x) => x.item.group === g)
      .map((x) => checkNode(x.item, x.at, x.at === focusedAt, s.fix));

    return rows.length === 0
      ? []
      : [
          {
            kind: 'SettingsGroup',
            id: `settings:checks:${g}`,
            props: captionOf(g, rows),
            children: rows,
          },
        ];
  });

  return page(crumbs, scope, groups, s.row);
};

/** A problem's fix as the strip names it. */
export const problemFixId = (p: SettingsProblem, command: string) => `problem:${p.code}:${command}`;

/** The fix a line's ⏎ queues: a check's, or a problem's `fix…`. */
const fixItemOf = (l: Line | undefined): string | undefined => {
  if (l?.kind === 'check') return l.item.id;
  if (l?.kind === 'problem' && l.problem.way.kind === 'fix')
    return problemFixId(l.problem, l.problem.way.command);

  return undefined;
};

/**
 * The strip goes where its ⏎ would not run it (#300): a queued fix once the cursor leaves its
 * row, an ended one once its page is left. A running one stays: Esc stops it.
 */
export const fixLeft = (r: SettingsDialogRules, before: SettingsState, out: Out): Out => {
  const s = out.state;
  const f = s.fix;

  if (f === undefined || f.state === 'running' || !s.open) return out;
  const left =
    f.state === 'queued'
      ? s.focus !== 'page' || fixItemOf(focusedLine(r, s)) !== f.item
      : results(s) !== results(before) || pageShown(r, s) !== pageShown(r, before);

  return left ? { ...out, state: { ...s, fix: undefined } } : out;
};

/** The strip under Logins & tools while a fix is typed in, running or ended. */
export const fixNode = (s: SettingsState): SettingsFix | undefined => {
  const f = s.fix;

  if (f === undefined) return undefined;
  const state = ((): { state: string; stateTone?: SettingsTone } => {
    switch (f.state) {
      case 'queued':
        return { state: 'queued · ⏎ runs it · Esc drops it' };
      case 'running':
        return { state: 'running · Esc stops it', stateTone: 'accent' };
      case 'ended':
        return f.exit === 0
          ? { state: 'ended · checked again' }
          : { state: `ended · exit ${f.exit ?? '?'} · checked again`, stateTone: 'bad' };
    }
  })();
  const terminal: Node[] =
    f.key === undefined
      ? []
      : [
          {
            kind: 'Terminal',
            id: 'settings-fix-terminal',
            props: {
              key: f.key,
              argv: ['/bin/zsh', '-lc', f.command],
              ...(f.state === 'running' ? { focused: true } : {}),
              screenKeys: ['<Esc>'],
            },
          },
        ];

  return {
    kind: 'SettingsFix',
    id: 'settings:fix',
    props: {
      title: `fix · ${f.label}`,
      ...state,
      command: `$ ${f.command}`,
      note: 'A fix runs below in a real terminal; the row checks again when it ends',
    },
    children: terminal,
  };
};
