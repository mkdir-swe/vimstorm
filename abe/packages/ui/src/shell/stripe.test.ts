/**
 * The stripe (#20): which items it shows and where, each dot per state (news, never a
 * count), what each place draws, the right-click menu, and your tweaks it writes.
 */
import { describe, expect, test } from 'bun:test';
import type { PipelineRun, ViewTweak } from '@abe/core';
import { PIPELINES_ME, pipelineRun, X_BOXES } from '@abe/testing';
import { boxesBadge } from '../live/box-feed';
import { type StripeItem } from '../runtime/protocol';
import {
  pipelinesDot,
  type StripeAt,
  stripeAt,
  stripeChangeOf,
  type StripeFacts,
  stripeGear,
  stripeItems,
  stripeMenu,
  stripeTweaks,
} from './stripe';

const NONE: StripeFacts = { counts: { needsYou: 0, running: 0 } };

const item = (items: readonly StripeItem[], id: string) => {
  const found = items.find((i) => i.id === id);

  if (found === undefined) throw new Error(`no ${id}`);

  return found;
};

/** What a place draws, as `group:id`, `*` picked, `•<dot>` with news. */
const drawn = (items: readonly StripeItem[], at: StripeAt) => {
  const d = stripeAt(items, at);
  const one = (g: string) => (i: { id: string; picked?: true; dot?: string }) =>
    `${g}:${i.id}${i.picked === true ? '*' : ''}${i.dot === undefined ? '' : `•${i.dot}`}`;

  return [...d.top.map(one('top')), ...d.bottom.map(one('bottom'))];
};

describe('the items per place', () => {
  test.each<[string, StripeAt, string[]]>([
    [
      'a developer in a workspace: every item, Project picked',
      { place: 'project' },
      [
        'top:project*',
        'top:board',
        'top:run',
        'top:more',
        'bottom:terminal',
        'bottom:sessions',
        'bottom:boxes',
        'bottom:pipelines',
        'bottom:git',
      ],
    ],
    [
      'on the Board: Run, Terminal and Git leave the stripe',
      { place: 'board' },
      [
        'top:project',
        'top:board*',
        'top:more',
        'bottom:sessions',
        'bottom:boxes',
        'bottom:pipelines',
      ],
    ],
    [
      'Run (a workspace’s) with Sessions open below: both picked',
      { place: 'run', pane: 'sessions' },
      [
        'top:project',
        'top:board',
        'top:run*',
        'top:more',
        'bottom:terminal',
        'bottom:sessions*',
        'bottom:boxes',
        'bottom:pipelines',
        'bottom:git',
      ],
    ],
  ])('%s', (_, at, ids) => {
    expect(drawn(stripeItems(NONE), at)).toEqual(ids);
  });

  test('nothing to say: no dot; the tooltip names the item, its key and what it is', () => {
    const items = stripeItems(NONE);

    expect(items.filter((i) => i.dot !== undefined)).toEqual([]);
    expect(items.map((i) => i.tooltip)).toEqual([
      'Project · ⌘1 · the code: tree and editor',
      'Board · ⌘⌥A',
      'Run · the path the agent took',
      'Terminal · ⌃`',
      'Sessions · ⌘5',
      'Boxes · ⌘6',
      'Pipelines · ⌘7',
      'Git',
    ]);
    expect(item(items, 'run').icon).toBe('run-path');
    expect(item(items, 'git').key).toBe(undefined);
  });
});

describe('the dots', () => {
  test.each<[string, StripeFacts['counts'], Partial<StripeItem>]>([
    ['two running: running', { needsYou: 0, running: 2 }, { dot: 'running' }],
    [
      'one asks: needs you, the running in words',
      { needsYou: 1, running: 1 },
      { dot: 'needs-you', tooltip: 'Sessions · ⌘5 · 1 needs you · 1 running' },
    ],
    [
      'one failed, nothing asks',
      { needsYou: 0, running: 0, failed: 1 },
      { dot: 'failed', tooltip: 'Sessions · ⌘5 · 1 failed' },
    ],
  ])('Sessions, %s', (_, counts, want) => {
    expect(item(stripeItems({ ...NONE, counts }), 'sessions')).toMatchObject(want);
  });

  test('Board carries what needs you, and nothing when nothing asks', () => {
    const waiting = [{ card: 4, title: 'Cart total' }];

    expect(
      item(stripeItems({ ...NONE, counts: { needsYou: 1, running: 0 }, waiting }), 'board'),
    ).toMatchObject({ dot: 'needs-you', tooltip: 'Board · ⌘⌥A · #4 Cart total needs you' });
    expect(item(stripeItems({ ...NONE, counts: { needsYou: 0, running: 3 } }), 'board').dot).toBe(
      undefined,
    );
  });

  test('Settings, the toolbar’s gear: a dot while it lists problems', () => {
    expect(stripeGear(2)).toEqual({ tooltip: 'Settings · ⌘, · 2 problems', dot: 'failed' });
    expect(stripeGear(0)).toEqual({ tooltip: 'Settings · ⌘,' });
  });

  const NOW = Date.parse(X_BOXES.now);

  test('Boxes: the count in words, no dot; a stuck box failed', () => {
    const list = { boxes: [X_BOXES.running, X_BOXES.asleep], queued: [] };
    const fine = item(stripeItems({ ...NONE, boxes: boxesBadge(list, NOW) }), 'boxes');

    expect(fine.dot).toBe(undefined);
    expect(fine.tooltip).toStartWith('Boxes · ⌘6 · 2 boxes, 1 running');
    const stuck = boxesBadge({ boxes: [X_BOXES.running, X_BOXES.stuck], queued: [] }, NOW);

    expect(item(stripeItems({ ...NONE, boxes: stuck }), 'boxes').dot).toBe('failed');
    expect(stuck?.words).toContain('demo-shop-2');
  });
});

describe('your tweaks: hidden, moved, reset', () => {
  const hide = (id: string): ViewTweak => ({ screen: 'factory', node: `stripe:${id}`, hide: true });
  const move = (id: string, group: 'top' | 'bottom'): ViewTweak => ({
    screen: 'factory',
    node: `stripe:${id}`,
    group,
  });
  const OTHER: ViewTweak = { screen: 'factory', node: 'col:Closed', hide: true };

  test('a hidden item stays in the list (the menu unticks it) but is not drawn; a moved one sits in its group', () => {
    const items = stripeItems({ ...NONE, tweaks: [hide('pipelines'), move('git', 'top')] });

    expect(item(items, 'pipelines').hidden).toBe(true);
    expect(drawn(items, { place: 'project' })).toEqual([
      'top:project*',
      'top:board',
      'top:run',
      'top:git',
      'top:more',
      'bottom:terminal',
      'bottom:sessions',
      'bottom:boxes',
    ]);
  });

  test.each<[string, string, readonly ViewTweak[], ViewTweak[]]>([
    ['hide Pipelines', 'toggle:pipelines', [OTHER], [OTHER, hide('pipelines')]],
    ['show it again', 'toggle:pipelines', [OTHER, hide('pipelines')], [OTHER]],
    ['Git to the top', 'top:git', [], [move('git', 'top')]],
    ['Git back to its own group: no tweak kept', 'bottom:git', [move('git', 'top')], []],
    [
      'reset: every stripe tweak gone, the rest kept',
      'reset',
      [hide('boxes'), OTHER, move('git', 'top')],
      [OTHER],
    ],
  ])('%s', (_, choice, before, after) => {
    const change = stripeChangeOf(`widget:stripe-menu:${choice}`);

    expect(change).toBeDefined();
    if (change !== undefined) expect(stripeTweaks(before, change)).toEqual(after);
  });

  test('a click naming no item changes nothing', () => {
    expect(stripeChangeOf('widget:stripe-menu:toggle:nope')).toBe(undefined);
    expect(stripeChangeOf('widget:stripe:git')).toBe(undefined);
  });
});

describe('the right-click menu', () => {
  const HIDDEN: ViewTweak = { screen: 'factory', node: 'stripe:pipelines', hide: true };
  const rows = (here: boolean, at?: string) =>
    stripeMenu(stripeItems({ ...NONE, tweaks: [HIDDEN] }), here, at).map((r) => {
      switch (r.kind) {
        case 'toggle':
          return `${r.on ? '✓' : ' '} ${r.label}${r.enabled ? '' : ' (grey)'}`;
        case 'separator':
          return '—';
        case 'info':
          return `[${r.text}]`;
        case 'action':
          return r.label;
      }
    });

  test.each<[string, boolean, string | undefined, string[]]>([
    [
      'in a workspace, on Pipelines',
      true,
      'pipelines',
      [
        '✓ Project',
        '✓ Board',
        '—',
        '✓ Sessions',
        '✓ Boxes',
        '  Pipelines',
        '—',
        '[In a workspace]',
        '✓ Run',
        '✓ Terminal',
        '✓ Git',
        '—',
        'Move to Top Group',
        'Reset the Stripe',
      ],
    ],
    [
      'on the Board: Run, Terminal and Git greyed, only in a workspace',
      false,
      'board',
      [
        '✓ Project',
        '✓ Board',
        '—',
        '✓ Sessions',
        '✓ Boxes',
        '  Pipelines',
        '—',
        '[Only in a workspace]',
        '✓ Run (grey)',
        '✓ Terminal (grey)',
        '✓ Git (grey)',
        '—',
        'Move to Bottom Group',
        'Reset the Stripe',
      ],
    ],
  ])('%s', (_, here, at, want) => {
    expect(rows(here, at)).toEqual(want);
  });
});

describe('Pipelines’ dot, from the runs its tab read', () => {
  const run = (id: string, more: Partial<PipelineRun>, at = '09:00'): PipelineRun =>
    pipelineRun(id, 'CI', 'a change', more.branch ?? 'feature/cart', at, 2, more);

  test('your branch’s latest run failed: failed; an older failure fixed since does not count', () => {
    expect(
      pipelinesDot(
        [
          run('2', { status: 'failed' }, '09:10'),
          run('1', {}),
          run('3', { status: 'failed', branch: 'feature/old' }, '08:00'),
          run('4', { branch: 'feature/old' }, '08:30'),
          run('5', { status: 'failed', actor: 'sam', branch: 'feature/sam' }),
          // a teammate's rerun on your branch, green: that branch is fine now
          run('8', { status: 'failed', branch: 'feature/rerun' }, '07:00'),
          run('9', { actor: 'sam', branch: 'feature/rerun' }, '07:30'),
        ],
        PIPELINES_ME,
      ),
    ).toEqual({
      kind: 'stripe-dot',
      id: 'pipelines',
      dot: 'failed',
      words: '1 run failed on your branch',
    });
  });

  test('a deploy waiting for your approval: needs you; nothing: no dot', () => {
    const gate = {
      id: 'g',
      kind: 'environment' as const,
      environment: 'test',
      since: null,
      canApprove: true,
    };
    const stage = {
      name: 'test',
      status: 'waiting' as const,
      startedAt: null,
      finishedAt: null,
      gate,
    };
    const waiting = run('6', { status: 'waiting', stages: [stage] });
    const notMine = run('8', {
      status: 'waiting',
      stages: [{ ...stage, gate: { ...gate, canApprove: false } }],
    });

    expect(pipelinesDot([waiting], PIPELINES_ME)).toMatchObject({ dot: 'needs-you' });
    expect(pipelinesDot([notMine, run('7', {})], PIPELINES_ME)).toEqual({
      kind: 'stripe-dot',
      id: 'pipelines',
    });
  });
});
