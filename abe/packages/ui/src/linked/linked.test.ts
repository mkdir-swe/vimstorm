/**
 * The Linked popup (#109 S2–S3, board W-Linked) as Command mode's layer: ⌃L reads `abe story
 * linked`, a run per part (#341) drawn as each lands, the nine rows in Search Everywhere's look,
 * every letter filters at once while ↑ ↓ ⌃N ⌃P move, ⏎ opens the row (each row's target), a dim row
 * only says its words, Esc closes, and the rows follow `abe watch` with the cursor kept on its
 * row, one run of a part out at a time (#124).
 */
import { describe, expect, test } from 'bun:test';
import {
  Event,
  LINKED_KEYS,
  LINKED_PARTS as PARTS,
  type LinkedKey,
  type LinkedOpens,
  type StoryLinkedData,
} from '@abe/core';
import { LINKED_ENV, LINKED_PARTS, LINKED_STORY, minutes } from '@abe/testing';
import { commandMode } from '../command/command';
import { type Node } from '../runtime/components';
import { LINKED_HINT, opensOf } from './linked';
import { type LinkedLayerNode } from './linked-layer';
import { linkedOf } from './linked-rows';
import { type Command, type Input, mountLayer } from '../runtime/runtime';
import { WORDS } from '../runtime/screens';

const DATA: StoryLinkedData = linkedOf(LINKED_PARTS, LINKED_ENV);

/** A part's answer as serve says it: every row but `own` `Reading…`. */
const partOf = (...own: LinkedKey[]): StoryLinkedData =>
  linkedOf({ ...LINKED_PARTS, reading: LINKED_KEYS.filter((k) => !own.includes(k)) }, LINKED_ENV);

/** The run of each part ⌃L asks first, `linked:2:1` … `linked:2:6`. */
const RUN_OF = Object.fromEntries(PARTS.map((p, i) => [p, `linked:2:${i + 1}`]));

const answer = (id: string, data: StoryLinkedData = DATA): Input => ({
  kind: 'result',
  id,
  command: 'story linked',
  reply: { ok: true, data },
});

/** Command mode with ⌃L handed on for #2, its first read answered unless `read` is false. */
const drive = (read = true) => {
  const layer = mountLayer(commandMode(WORDS));
  const out: Command[] = [];
  const d = {
    out,
    send(...inputs: Input[]) {
      for (const input of inputs) out.push(...layer.send(input));

      return d;
    },
    keys(...keys: string[]) {
      return d.send(...keys.map((key): Input => ({ kind: 'key', key })));
    },
    get node(): Node | undefined {
      return layer.tree;
    },
    get props(): LinkedLayerNode['props'] {
      const n = layer.tree;

      if (n?.kind !== 'LinkedLayer') throw new Error(`no Linked up: ${n?.kind ?? 'none'}`);

      return n.props;
    },
    get linked() {
      return layer.linked();
    },
    /** The runs asked, by id. */
    runs: () => out.flatMap((c) => (c.kind === 'run' ? [{ id: c.id, argv: c.argv }] : [])),
  };

  d.send({ kind: 'tick', at: LINKED_ENV.now }, { kind: 'jump', to: 'linked', story: LINKED_STORY });
  if (read) d.send(answer('linked:2:1'));

  return d;
};

const labels = (p: LinkedLayerNode['props']) => p.rows.map((r) => r.label);
const text = (p: LinkedLayerNode['props'], id: string) =>
  p.rows
    .find((r) => r.id === id)
    ?.value.map((v) => v.text)
    .join('');

describe('⌃L opens Linked on the story', () => {
  test('it opens at once: the nine rows Reading…, each part its own run; the title, ⌃L dim and the footer (#341)', () => {
    const d = drive(false);

    expect(d.runs()).toEqual(
      PARTS.map((part, i) => ({
        id: `linked:2:${i + 1}`,
        argv: ['story', 'linked', '2', '--part', part],
      })),
    );
    expect(d.props).toMatchObject({ story: '#2', keys: '⌃L' });
    expect(d.props.state).toBeUndefined();
    expect(d.props.rows.map((r) => [r.label, r.value.map((v) => v.text).join(''), r.dim])).toEqual(
      labels(drive().props).map((label) => [label, 'Reading…', true]),
    );
    expect(d.props.selected).toBe('linked:row:story');
    expect(d.props.hint).toBe('⏎ open · Esc close');
    expect(d.props.hint).toBe(LINKED_HINT);
    // the popup's story is what a jump from it goes along
    expect(d.linked).toBe(2);
  });

  test('its answer: the nine rows in order, the first selected, an empty one dim in place', () => {
    const p = drive().props;

    expect(p.story).toBe('#2 The cart total ignores quantity');
    expect(labels(p)).toEqual([
      'Story',
      'Prototype',
      'Spec',
      'Sessions',
      'Pull request',
      'Pipelines',
      'Worktree',
      'Box',
      'Sheets',
    ]);
    expect(p.selected).toBe('linked:row:story');
    expect(p.rows.find((r) => r.id === 'linked:row:pr')).toEqual({
      id: 'linked:row:pr',
      label: 'Pull request',
      value: [{ text: 'none yet' }],
      dim: true,
    });
    expect(text(p, 'linked:row:story')).toBe('Active · Bug · AE');
  });

  test('a mark’s word in its hue', () => {
    const p = drive().props;

    expect(p.rows.find((r) => r.id === 'linked:row:pipelines')?.value).toEqual([
      { text: 'ci ' },
      { text: '✓ passed', hue: 'good' },
      { text: ' on card/2-… · 12 min ago' },
    ]);
  });

  test('each part draws its own rows as it lands, the others still Reading…; the title with the card (#341)', () => {
    const d = drive(false).send(answer(RUN_OF.run ?? '', partOf('sessions', 'worktree')));

    expect(d.props.story).toBe('#2 The cart total ignores quantity');
    expect(text(d.props, 'linked:row:sessions')).toBe('1 · Local sandbox · 2 subagents');
    expect(d.props.rows.some((r) => r.id === 'linked:row:run')).toBe(false);
    expect(text(d.props, 'linked:row:story')).toBe('Reading…');
    expect(text(d.props, 'linked:row:pipelines')).toBe('Reading…');
    d.send(answer(RUN_OF.pipelines ?? '', partOf('pipelines')));
    expect(text(d.props, 'linked:row:pipelines')).toBe('ci ✓ passed on card/2-… · 12 min ago');
    // a later part's answer leaves the rows it did not read as they were
    expect(text(d.props, 'linked:row:sessions')).toBe('1 · Local sandbox · 2 subagents');
    d.send(answer(RUN_OF.card ?? '', partOf('story', 'sheets')));
    expect(text(d.props, 'linked:row:story')).toBe('Active · Bug · AE');
    expect(text(d.props, 'linked:row:box')).toBe('Reading…');
  });

  test('every part failing says why; an answer of no run out is no one’s', () => {
    const failed = (id: string): Input => ({
      kind: 'result',
      id,
      command: 'story linked',
      reply: { ok: false, error: { code: 'serve-unreachable', message: 'serve is not answering' } },
    });
    const d = drive(false).send(...Object.values(RUN_OF).slice(0, -1).map(failed));

    // not yet: one part is still out, its rows Reading…
    expect(d.props.state).toBeUndefined();
    d.send(failed(RUN_OF.box ?? ''));
    expect(d.props).toMatchObject({ state: 'error', message: 'serve is not answering' });
    d.send(answer('linked:2:0'));
    expect(d.props.rows).toEqual([]);
  });

  test('a part failing whole: once all are in, its rows say why, the rest drawn', () => {
    const d = drive(false).send({
      kind: 'result',
      id: RUN_OF.pr ?? '',
      command: 'story linked',
      reply: { ok: false, error: { code: 'failed', message: 'gh went away' } },
    });

    for (const part of PARTS.filter((p) => p !== 'pr'))
      d.send(answer(RUN_OF[part] ?? '', partOf(...LINKED_KEYS.filter((k) => k !== 'pr'))));
    expect(d.props.state).toBeUndefined();
    expect(text(d.props, 'linked:row:pr')).toBe('not read · gh went away');
    expect(text(d.props, 'linked:row:story')).toBe('Active · Bug · AE');
  });
});

describe('its keys', () => {
  test('typing pull leaves the Pull request row (every letter types); arrows and ⌃N ⌃P move', () => {
    const d = drive().keys('p', 'u', 'l', 'l');

    expect(d.props.filter).toBe('pull');
    expect(labels(d.props)).toEqual(['Pull request']);
    expect(d.props.selected).toBe('linked:row:pr');
    d.keys('<BS>', '<BS>', '<BS>', '<BS>', '<Down>', '<Down>', '<C-n>', '<Down>');
    expect(d.props.filter).toBe('');
    expect(d.props.selected).toBe('linked:row:pr');
    d.keys('<C-p>', '<Up>');
    expect(d.props.selected).toBe('linked:row:spec');
  });

  test('Home / End the first and the last row (#334)', () => {
    const d = drive().keys('<End>');
    const rows = d.props.rows;

    expect(rows.length).toBeGreaterThan(2);
    expect(d.props.selected).toBe(rows.at(-1)?.id);
    expect(d.props.selected).not.toBe(rows[0]?.id);
    d.keys('<Home>');
    expect(d.props.selected).toBe(rows[0]?.id);
  });

  test('⏎ on Worktree is the workspace jump, the popup gone', () => {
    const d = drive().keys('w', 'o', 'r');

    expect(d.props.selected).toBe('linked:row:worktree');
    d.keys('<CR>');
    expect(d.node).toBeUndefined();
    expect(d.out.at(-1)).toEqual({ kind: 'jump', to: 'workspace', story: 2 });
  });

  test('⏎ on a dim row only says its words on the status line; the popup stays', () => {
    const d = drive().keys('p', 'u', '<CR>');

    expect(d.node?.kind).toBe('LinkedLayer');
    expect(d.out.at(-1)).toEqual({
      kind: 'shell',
      effect: { kind: 'status', text: 'Pull request · none yet' },
    });
  });

  test('a click on a row opens it; Esc closes', () => {
    const d = drive().send({ kind: 'click', id: 'linked:row:story' });

    expect(d.node).toBeUndefined();
    expect(d.out.at(-1)).toEqual({ kind: 'jump', to: 'story', story: 2 });
    expect(drive().keys('<Esc>').node).toBeUndefined();
  });

  test('⌃L again on another story reads that one in its place', () => {
    const d = drive().send({ kind: 'jump', to: 'linked', story: 7 });

    expect(d.props.story).toBe('#7');
    expect(d.runs().at(-1)).toEqual({
      id: 'linked:7:12',
      argv: ['story', 'linked', '7', '--part', 'box'],
    });
    // #2's answers are no one's now
    d.send(answer(RUN_OF.run ?? ''));
    expect(text(d.props, 'linked:row:sessions')).toBe('Reading…');
  });

  test('the workspace jump from it leaves every layer for the workspace', () => {
    const d = drive().send({ kind: 'jump', to: 'workspace', story: 2 });

    expect(d.node).toBeUndefined();
  });
});

describe('live from abe watch', () => {
  const moved = Event.parse({
    seq: 5,
    at: minutes(21),
    type: 'factory.stage',
    data: {
      card: LINKED_STORY,
      session: '2-a1b2',
      stage: 'review',
      from: 'build',
      state: 'running',
      reason: null,
      since: minutes(20),
      cause: 'checks',
      outcome: null,
    },
  });

  test('the run moving to Review reads again, the rows as they were; the cursor stays on its row', () => {
    const d = drive().keys('<Down>', '<Down>', '<Down>', '<Down>', '<Down>', '<Down>');
    const rowsBefore = d.props.rows;

    expect(d.props.selected).toBe('linked:row:worktree');
    d.send({ kind: 'event', event: moved });
    expect(d.props.rows).toEqual(rowsBefore);
    expect(d.props.selected).toBe('linked:row:worktree');
    // and the rest is read again: the card part, answered, at once; the others still out after
    expect(d.runs().at(-1)).toEqual({
      id: 'linked:2:7',
      argv: ['story', 'linked', '2', '--part', 'card'],
    });
    d.send(answer('linked:2:7'));
    expect(d.props.selected).toBe('linked:row:worktree');
  });

  test('events while a part is out: one run each at a time, read once more after (#124)', () => {
    const d = drive(false);
    const before = d.runs().length;

    // a burst while every part is out: no run more, and no answer of theirs left for a newer one
    for (let i = 0; i < 5; i++) d.send({ kind: 'event', event: { ...moved, seq: 10 + i } });
    expect(d.runs()).toHaveLength(before);
    d.send(answer(RUN_OF.run ?? '', partOf('sessions', 'worktree')));
    // its answer in, the part is read once more, the others' still out
    expect(d.runs().slice(before)).toEqual([
      { id: 'linked:2:7', argv: ['story', 'linked', '2', '--part', 'run'] },
    ]);
    d.send(answer('linked:2:7', partOf('sessions', 'worktree')));
    expect(d.runs()).toHaveLength(before + 1);
  });

  test('an answer read before an event leaves the rows it says in; the read after it asks the run part again (#341)', () => {
    const d = drive();
    const before = d.runs().length;

    d.send({ kind: 'event', event: moved });
    // the run part's answer, read before the run moved
    d.send(answer(RUN_OF.run ?? '', partOf('sessions', 'worktree')));
    // and the rows it alone says are in
    expect(text(d.props, 'linked:row:worktree')).toBe(text(drive().props, 'linked:row:worktree'));
    // the read the event asked for is what says the run from now on
    const [again] = d.runs().slice(before + 1);

    expect(again?.argv).toEqual(['story', 'linked', '2', '--part', 'run']);
  });

  test('an answer that is not Linked’s is that part’s failure: no row left Reading… (#341)', () => {
    const d = drive(false);

    for (const p of PARTS)
      d.send({
        kind: 'result',
        id: RUN_OF[p] ?? '',
        command: 'card show',
        reply: { ok: true, data: LINKED_PARTS.card.data },
      });
    expect(d.props).toMatchObject({ state: 'error', message: 'not a Linked answer: card show' });
  });

  test('closed, an event reads nothing', () => {
    const d = drive().keys('<Esc>');
    const before = d.runs().length;

    d.send({ kind: 'event', event: moved });
    expect(d.runs()).toHaveLength(before);
  });
});

describe('what ⏎ opens (#109 Behaviour 5)', () => {
  test.each<[string, LinkedOpens, Command[]]>([
    [
      'Story: the story dialog',
      { kind: 'story', card: 2 },
      [{ kind: 'jump', to: 'story', story: 2 }],
    ],
    [
      'Spec issue: the browser',
      { kind: 'url', url: 'https://github.com/demo/x/issues/9' },
      [{ kind: 'shell', effect: { kind: 'open-url', url: 'https://github.com/demo/x/issues/9' } }],
    ],
    [
      'Spec written: its file',
      { kind: 'file', path: '/w/.abe/spec.md' },
      [{ kind: 'shell', effect: { kind: 'open-file', path: '/w/.abe/spec.md' } }],
    ],
    [
      'Run: the Factory view on the card',
      { kind: 'factory', card: 2 },
      [
        { kind: 'shell', effect: { kind: 'view', view: 'factory' } },
        { kind: 'open', screen: 'factory', params: { card: '2' } },
      ],
    ],
    [
      'one session: it in the Chat column',
      { kind: 'sessions', ids: ['2-a1b2'] },
      [
        { kind: 'open', screen: 'chat', params: { session: '2-a1b2' }, slot: 'chat' },
        { kind: 'shell', effect: { kind: 'show', place: 'chat' } },
      ],
    ],
    [
      'one ended session: reopened (#343), it in the Chat column',
      { kind: 'sessions', ids: ['2-a1b2'], reopen: '2-a1b2' },
      [
        { kind: 'run', id: 'reopen:2', argv: ['session', 'reopen', '2-a1b2'] },
        { kind: 'open', screen: 'chat', params: { session: '2-a1b2' }, slot: 'chat' },
        { kind: 'shell', effect: { kind: 'show', place: 'chat' } },
      ],
    ],
    [
      'Pipelines: the pane’s Pipelines tab on that run',
      { kind: 'pipeline', id: '7001', url: 'https://x' },
      [
        { kind: 'open', screen: 'pipelines', params: { run: '7001' }, slot: 'pane' },
        { kind: 'shell', effect: { kind: 'show', place: 'pipelines' } },
      ],
    ],
    [
      'Worktree: the workspace',
      { kind: 'workspace', session: '2-a1b2', path: '/w' },
      [{ kind: 'jump', to: 'workspace', story: 2 }],
    ],
    [
      'Box: the pane’s Boxes tab on that row',
      { kind: 'box', name: 'demo-shop-102' },
      [
        { kind: 'open', screen: 'boxes', params: { box: 'demo-shop-102' }, slot: 'pane' },
        { kind: 'shell', effect: { kind: 'show', place: 'boxes' } },
      ],
    ],
    [
      'Box: the pane’s Boxes tab on the card’s workspace row (ADR 0022)',
      { kind: 'box', name: 'demo-shop', card: 101 },
      [
        {
          kind: 'open',
          screen: 'boxes',
          params: { box: 'demo-shop', card: '101' },
          slot: 'pane',
        },
        { kind: 'shell', effect: { kind: 'show', place: 'boxes' } },
      ],
    ],
    [
      'one Sheet: its tab on the Factory view',
      { kind: 'sheets', refs: ['2/before-after'] },
      [
        { kind: 'shell', effect: { kind: 'view', view: 'factory' } },
        { kind: 'open', screen: 'factory', params: { sheet: '2/before-after', card: '2' } },
      ],
    ],
  ])('%s', (_, opens, commands) => {
    expect(opensOf(2, opens)).toEqual(commands);
  });

  test('several sessions or Sheets: a pick of them, each row its own', () => {
    const [pick] = opensOf(2, { kind: 'sessions', ids: ['2-a1b2', '2-box'] });

    expect(pick).toMatchObject({ kind: 'menu', title: 'Sessions · #2' });
    if (pick?.kind !== 'menu') throw new Error('no pick');
    expect(pick.rows.map((r) => [r.id, r.does])).toEqual([
      [
        '2-a1b2',
        {
          kind: 'do',
          commands: [
            { kind: 'open', screen: 'chat', params: { session: '2-a1b2' }, slot: 'chat' },
            { kind: 'shell', effect: { kind: 'show', place: 'chat' } },
          ],
        },
      ],
      [
        '2-box',
        {
          kind: 'do',
          commands: [
            { kind: 'open', screen: 'chat', params: { session: '2-box' }, slot: 'chat' },
            { kind: 'shell', effect: { kind: 'show', place: 'chat' } },
          ],
        },
      ],
    ]);
    expect(opensOf(2, { kind: 'sheets', refs: ['a', 'b'] })[0]).toMatchObject({
      kind: 'menu',
      title: 'Sheets · #2',
    });
  });
});
