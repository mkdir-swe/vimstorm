/**
 * The stripe (#20, boards ST-*): WebStorm's tool window stripe at the window's left edge, which
 * replaced the ear (#240). The top group holds the places (Project, Board, Run, then ⋯),
 * one click swapping the main area; the bottom group what opens under the code (Terminal, then
 * Sessions, Boxes, Pipelines and Git). Run, Terminal and Git are a workspace's: on the
 * Board they leave the stripe, and the right-click menu greys them as "Only in a
 * workspace".
 *
 * This module is the one list of stripe items ([`STRIPE`]): a place another track draws (Run)
 * adds its renderer by id on the Rust side and its click in [`stripeClick`]'s caller.
 *
 * The picked item is a filled accent square; a dot means news (needs you, failed, running), never
 * a count; the tooltip says the name, its key and what the dot means. Hiding an item or moving it
 * to the other group is a personal View tweak (`stripe:<id>` on the `factory` screen: `hide` or
 * `group`). Pure: the Board's screen builds the items from the reads it holds, the shell draws
 * them ([`stripeAt`], [`stripeMenu`] are what it draws, the contract's `stripe/` fixtures).
 */
import { gatesOf, type PipelineRun, waits } from '@abe/core/pipelines';
import { type ViewTweak } from '@abe/core';
import {
  type StripeDot,
  type StripeDotEffect,
  type StripeGear,
  type StripeGroup,
  type StripeItem,
} from '../runtime/protocol';

/** One item of the stripe as this module knows it, before the facts and your tweaks. */
type Entry = {
  id: StripeId;
  label: string;
  /** The icon's name as the shell draws it. */
  icon: string;
  group: StripeGroup;
  /** Only inside a workspace (Run, Terminal, Git). */
  workspaceOnly?: true;
  /** Its key, in the tooltip and the menu. */
  key?: string;
  /** What it is, in the tooltip while its dot says nothing. */
  what?: string;
};

/** Every stripe item's id, in the stripe's order. */
export const STRIPE_IDS = [
  'project',
  'board',
  'run',
  'terminal',
  'sessions',
  'boxes',
  'pipelines',
  'git',
] as const;
export type StripeId = (typeof STRIPE_IDS)[number];

/** The places: one click swaps the main area (the rest open under the code). */
export const STRIPE_PLACES: readonly StripeId[] = ['project', 'board', 'run'];

/**
 * The stripe, in order: the one list. Git's key, ⌘3 (the bottom panel's Git), is Go to's (`GO_WHERE`).
 */
export const STRIPE: readonly Entry[] = [
  {
    id: 'project',
    label: 'Project',
    icon: 'project',
    group: 'top',
    key: '⌘1',
    what: 'the code: tree and editor',
  },
  { id: 'board', label: 'Board', icon: 'board', group: 'top', key: '⌘⌥A' },
  {
    id: 'run',
    label: 'Run',
    icon: 'run-path',
    group: 'top',
    workspaceOnly: true,
    what: 'the path the agent took',
  },
  // Terminal first, Sessions beside it: ⌃⌥← / → steps between them
  {
    id: 'terminal',
    label: 'Terminal',
    icon: 'terminal',
    group: 'bottom',
    workspaceOnly: true,
    key: '⌃`',
  },
  { id: 'sessions', label: 'Sessions', icon: 'history', group: 'bottom', key: '⌘5' },
  { id: 'boxes', label: 'Boxes', icon: 'archive', group: 'bottom', key: '⌘6' },
  { id: 'pipelines', label: 'Pipelines', icon: 'run', group: 'bottom', key: '⌘7' },
  {
    id: 'git',
    label: 'Git',
    icon: 'vcs',
    group: 'bottom',
    workspaceOnly: true,
  },
];

/** What the stripe says, as the Board's screen holds it. */
export type StripeFacts = {
  /** The sessions as the Sessions tab counts them (who needs you, what runs, what failed). */
  counts: { needsYou: number; running: number; failed?: number | undefined };
  /** What needs you, by name (`#4 Cart total`), for Sessions' and Board's tooltips. */
  waiting?: readonly { card: number; title: string }[] | undefined;
  /** The Boxes badge (`box-feed.ts` `boxesBadge`), none with no boxes. */
  boxes?: { badge: string; hue: 'dim' | 'bad' | 'warn'; words: string } | undefined;
  /** How many problems Settings lists first (`settings problems`, infos not counted). */
  problems?: number | undefined;
  /** Your view tweaks (the `factory` screen's): `stripe:<id>` hidden or moved. */
  tweaks?: readonly ViewTweak[] | undefined;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `Boxes · ⌘6 · 3 boxes, 1 running`: the name, its key and the dot in words. */
const tip = (...parts: (string | undefined)[]) =>
  parts.filter((p): p is string => p !== undefined && p !== '').join(' · ');

/** `#4 Cart total needs you`, or `2 need you` with no names. */
const needsWords = (n: number, waiting: StripeFacts['waiting']) => {
  const names = (waiting ?? []).map((w) => `#${w.card} ${w.title}`).join(' · ');

  return `${names === '' ? String(n) : names} ${n === 1 ? 'needs' : 'need'} you`;
};

/** An item's dot and its words, from the facts. */
const news = (id: StripeId, f: StripeFacts): { dot?: StripeDot; words?: string } => {
  const c = f.counts;
  const failed = c.failed ?? 0;

  switch (id) {
    case 'sessions': {
      const running = c.running > 0 ? `${c.running} running` : undefined;

      if (c.needsYou > 0)
        return {
          dot: 'needs-you',
          words: tip(needsWords(c.needsYou, f.waiting), running),
        };
      if (failed > 0) return { dot: 'failed', words: tip(`${failed} failed`, running) };

      return running === undefined ? {} : { dot: 'running', words: running };
    }
    case 'board':
      return c.needsYou > 0 ? { dot: 'needs-you', words: needsWords(c.needsYou, f.waiting) } : {};
    case 'boxes': {
      const b = f.boxes;

      if (b === undefined) return {};
      if (b.hue === 'bad') return { dot: 'failed', words: b.words };
      // a box about to sleep with a session waiting on you (#192)
      if (b.hue === 'warn') return { dot: 'needs-you', words: b.words };

      return { words: b.words };
    }
    default:
      return {};
  }
};

const nodeOf = (id: string) => `stripe:${id}`;

/** Your stripe tweaks: hidden ids, and the group each moved one is in. */
const layoutOf = (tweaks: readonly ViewTweak[] | undefined) => {
  const hidden = new Set<string>();
  const group = new Map<string, StripeGroup>();

  for (const t of tweaks ?? []) {
    if (t.screen !== 'factory' || !t.node.startsWith('stripe:')) continue;
    const id = t.node.slice('stripe:'.length);

    if (t.hide === true) hidden.add(id);
    if (t.group !== undefined) group.set(id, t.group);
  }

  return { hidden, group };
};

/**
 * The stripe's items, in order (the top group's, then the bottom's), each with its dot, its tooltip and your tweaks (`hidden`, the group it was moved to). Run,
 * Terminal and Git say `workspaceOnly`: the shell leaves them out on the Board.
 */
export const stripeItems = (f: StripeFacts): StripeItem[] => {
  const { hidden, group } = layoutOf(f.tweaks);
  const items = STRIPE.map((e): StripeItem => {
    const n = news(e.id, f);

    return {
      id: e.id,
      label: e.label,
      icon: e.icon,
      group: group.get(e.id) ?? e.group,
      ...(e.workspaceOnly === true ? { workspaceOnly: true as const } : {}),
      ...(hidden.has(e.id) ? { hidden: true as const } : {}),
      ...(e.key === undefined ? {} : { key: e.key }),
      ...(n.dot === undefined ? {} : { dot: n.dot }),
      tooltip: tip(e.label, e.key, n.words ?? e.what),
    };
  });

  return [...items.filter((i) => i.group === 'top'), ...items.filter((i) => i.group === 'bottom')];
};

/** Settings, the toolbar's gear (it stays there, #20): `⚠` amber while Settings lists problems. */
export const stripeGear = (problems: number | undefined): StripeGear =>
  problems === undefined || problems === 0
    ? { tooltip: 'Settings · ⌘,' }
    : { tooltip: tip('Settings', '⌘,', plural(problems, 'problem')), dot: 'failed' };

/** Where the window is: the place in the main area, the bottom tool window shown (if any). */
export type StripeAt = { place: 'project' | 'board' | 'run'; pane?: StripeId };

/** Whether the main area is a workspace's (the code, or its Run): Run, Terminal and Git show. */
export const inWorkspace = (at: StripeAt): boolean => at.place === 'project' || at.place === 'run';

/** One drawn stripe button: the picked one a filled accent square, a dot for news. */
export type StripeDrawn = {
  id: string;
  icon: string;
  picked?: true;
  dot?: StripeDot;
  tooltip: string;
};

/** ⋯ at the top group's end: the rest of the tool windows, as the right-click menu. */
const MORE: StripeDrawn = { id: 'more', icon: 'more', tooltip: 'More tool windows' };

/**
 * What the shell draws at `at` (the contract's `stripe/*.json`): the shown items by group, ⋯
 * last in the top group; the place picked, and the bottom tool window shown.
 */
export const stripeAt = (
  items: readonly StripeItem[],
  at: StripeAt,
): { top: StripeDrawn[]; bottom: StripeDrawn[] } => {
  const here = inWorkspace(at);
  const drawn = (g: StripeGroup) =>
    items
      .filter((i) => i.group === g && i.hidden !== true && (here || i.workspaceOnly !== true))
      .map((i): StripeDrawn => ({
        id: i.id,
        icon: i.icon,
        ...(i.id === at.place || i.id === at.pane ? { picked: true as const } : {}),
        ...(i.dot === undefined ? {} : { dot: i.dot }),
        tooltip: i.tooltip,
      }));

  return { top: [...drawn('top'), MORE], bottom: drawn('bottom') };
};

/** A row of the stripe's right-click menu (ST-Menu, ST-MenuBoard). */
export type StripeMenuRow =
  | { kind: 'toggle'; id: string; label: string; on: boolean; enabled: boolean }
  | { kind: 'separator' }
  | { kind: 'info'; text: string }
  | { kind: 'action'; action: 'top' | 'bottom' | 'reset'; label: string; id?: string };

/** A menu choice comes back as a click on `widget:stripe-menu:<toggle|top|bottom>:<id>` / `…:reset`. */
export const STRIPE_MENU = 'widget:stripe-menu:';

/** A click on a stripe item comes back as `widget:stripe:<id>` (the shell opens it itself too). */
export const STRIPE_CLICK = 'widget:stripe:';

/**
 * The right-click menu (on item `at`, or the stripe's empty room / ⋯): show or hide each item by
 * group, the workspace's under "In a workspace" (greyed "Only in a workspace" elsewhere), then
 * moving `at` to the other group, then Reset the Stripe.
 */
export const stripeMenu = (
  items: readonly StripeItem[],
  here: boolean,
  at?: string,
): StripeMenuRow[] => {
  const toggle = (i: StripeItem, enabled: boolean): StripeMenuRow => ({
    kind: 'toggle',
    id: i.id,
    label: i.label,
    on: i.hidden !== true,
    enabled,
  });
  const free = items.filter((i) => i.workspaceOnly !== true);
  const sections = [
    free.filter((i) => i.group === 'top').map((i) => toggle(i, true)),
    free.filter((i) => i.group === 'bottom').map((i) => toggle(i, true)),
  ].filter((s) => s.length > 0);
  const workspace = items.filter((i) => i.workspaceOnly === true);
  const rows: StripeMenuRow[] = sections.flatMap((s, i) =>
    i === 0 ? s : [{ kind: 'separator' as const }, ...s],
  );

  if (workspace.length > 0)
    rows.push(
      { kind: 'separator' },
      { kind: 'info', text: here ? 'In a workspace' : 'Only in a workspace' },
      ...workspace.map((i) => toggle(i, here)),
    );
  rows.push({ kind: 'separator' });
  const on = items.find((i) => i.id === at);

  if (on !== undefined && (here || on.workspaceOnly !== true))
    rows.push(
      on.group === 'top'
        ? { kind: 'action', action: 'bottom', label: 'Move to Bottom Group', id: on.id }
        : { kind: 'action', action: 'top', label: 'Move to Top Group', id: on.id },
    );
  rows.push({ kind: 'action', action: 'reset', label: 'Reset the Stripe' });

  return rows;
};

/** A menu choice, parsed from its click id. */
export type StripeChange = { kind: 'toggle' | 'top' | 'bottom'; id: StripeId } | { kind: 'reset' };

const isId = (id: string): id is StripeId => STRIPE_IDS.some((s) => s === id);

/** The change a `widget:stripe-menu:…` click asks for, if it names one. */
export const stripeChangeOf = (click: string): StripeChange | undefined => {
  if (!click.startsWith(STRIPE_MENU)) return undefined;
  const rest = click.slice(STRIPE_MENU.length);

  if (rest === 'reset') return { kind: 'reset' };
  const [kind, id] = rest.split(':');

  if (id === undefined || !isId(id)) return undefined;

  return kind === 'toggle' || kind === 'top' || kind === 'bottom' ? { kind, id } : undefined;
};

/**
 * Your `views` after a menu choice: the item shown again or hidden, moved to a group (none kept
 * for its own group), or every stripe tweak gone (Reset). Other tweaks are kept as they were.
 */
export const stripeTweaks = (all: readonly ViewTweak[], change: StripeChange): ViewTweak[] => {
  const isStripe = (t: ViewTweak) => t.screen === 'factory' && t.node.startsWith('stripe:');

  if (change.kind === 'reset') return all.filter((t) => !isStripe(t));
  const node = nodeOf(change.id);
  const mine = (t: ViewTweak) => t.screen === 'factory' && t.node === node;

  if (change.kind === 'toggle') {
    const hidden = all.some((t) => mine(t) && t.hide === true);
    const rest = all.filter((t) => !(mine(t) && t.hide === true));

    return hidden ? rest : [...rest, { screen: 'factory', node, hide: true }];
  }
  const rest = all.filter((t) => !(mine(t) && t.group !== undefined));
  const home = STRIPE.find((e) => e.id === change.id)?.group;

  return home === change.kind ? rest : [...rest, { screen: 'factory', node, group: change.kind }];
};

/**
 * Pipelines' dot (#240's badge), from the runs the Pipelines tab read: needs you for the runs
 * waiting at a gate you may approve; else failed for your branches whose latest run failed (a
 * branch you started a run on, its latest run whoever started it); else none.
 */
export const pipelinesDot = (
  runs: readonly PipelineRun[],
  me: string | null | undefined,
): StripeDotEffect => {
  const approve = runs.filter((r) => waits(r) && gatesOf(r).some((g) => g.gate.canApprove));

  if (approve.length > 0)
    return {
      kind: 'stripe-dot',
      id: 'pipelines',
      dot: 'needs-you',
      words: `${plural(approve.length, 'run')} to approve`,
    };
  // your branches: the ones you started a run on; each one's latest run, whoever started it
  const newest = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const mine = new Set(
    me === null || me === undefined ? [] : runs.filter((r) => r.actor === me).map((r) => r.branch),
  );
  const latest = new Map<string, PipelineRun>();

  for (const r of newest) if (mine.has(r.branch) && !latest.has(r.branch)) latest.set(r.branch, r);
  const failed = [...latest.values()].filter((r) => r.status === 'failed').length;

  return failed > 0
    ? {
        kind: 'stripe-dot',
        id: 'pipelines',
        dot: 'failed',
        words: `${plural(failed, 'run')} failed on your branch${failed === 1 ? '' : 'es'}`,
      }
    : { kind: 'stripe-dot', id: 'pipelines' };
};
