/**
 * The Launch box (#342, #347) in Command mode: typing writes the Launch note, ⇧⏎ a new line,
 * ↑ / ↓ the workflow (preselected by the card's on:), ⌃R where it runs, ⌃P prod for this session;
 * ⏎ hands `[note, workflow, runs, prod]` back, Esc keeps the draft per card, the standing notes dim, the count from 1500 and nothing launched past 2000.
 */
import { describe, expect, test } from 'bun:test';
import { loadWorkflows, type WorkflowSource } from '@abe/core';
import { commandMode } from './command';
import { type Node } from '../runtime/components';
import { type LaunchBox, type LaunchWorkflowRow } from '../runtime/layers';
import { type Command, type Input, type LaunchOn, mountLayer } from '../runtime/runtime';
import { WORDS } from '../runtime/screens';

const ON: LaunchOn = {
  kind: 'launch',
  id: 'launchbox:102',
  card: 102,
  title: 'Show VAT under the cart total',
  where: 'Cloud',
};

const box = (n: Node | undefined): LaunchBox['props'] => {
  if (n?.kind !== 'LaunchBox') throw new Error(`no Launch box up: ${n?.kind ?? 'none'}`);

  return n.props;
};

const open = () => {
  const layer = mountLayer(commandMode(WORDS));
  const out: Command[] = [];
  const d = {
    out,
    get props() {
      return box(layer.tree);
    },
    get tree() {
      return layer.tree;
    },
    send(...inputs: Input[]) {
      for (const i of inputs) out.push(...layer.send(i));

      return d;
    },
    keys(...keys: string[]) {
      return d.send(...keys.map((key): Input => ({ kind: 'key', key })));
    },
    type(text: string) {
      return d.send({ kind: 'text', text });
    },
    choices() {
      return out.filter((c) => c.kind === 'choice');
    },
  };

  return d.send(ON);
};

describe('the Launch box', () => {
  test('opens empty, where it runs, and reads the standing notes', () => {
    const d = open();

    expect(d.props).toMatchObject({
      title: 'Launch #102 Show VAT under the cart total',
      label: 'Notes for the agent (optional)',
      draft: '',
      along: [],
      where: 'Cloud',
      workflows: { rows: [], note: 'Reading the workflows…' },
      runs: [
        { id: 'local-sandbox', label: 'Local · its card worktree' },
        { id: 'cloud', label: 'A box · your environment' },
      ],
      ran: '',
      reach: [
        { env: 'dev', label: '✓ dev', on: true },
        { env: 'test', label: '✓ test', on: true },
        { env: 'prod', label: '○ prod off · on for one session only locally', on: false },
      ],
      hint: '⏎ Launch · ↑↓ workflow · ⌃R runs · ⌃P prod · ⇧⏎ new line · Esc',
    });
    expect(d.props.count).toBeUndefined();
    expect(d.out).toEqual([
      { kind: 'run', id: 'launch:standing:102', argv: ['settings', 'explain', 'launch.notes'] },
      { kind: 'run', id: 'launch:workflows:102', argv: ['workflow', 'list'] },
      ...['dev', 'test', 'prod'].map((env): Command => ({
        kind: 'run',
        id: `launch:reach-${env}:102`,
        argv: ['settings', 'get', `agents.${env}`],
      })),
    ]);
  });

  test('the standing notes in force show dim with whose each is; unreadable, none', () => {
    const d = open().send({
      kind: 'result',
      id: 'launch:standing:102',
      command: 'settings explain',
      reply: {
        ok: true,
        data: {
          key: 'launch.notes',
          value: ['keep PRs small', 'write the test first'],
          winner: 'individual',
          lowered: null,
          feel: 'vimstorm',
          problems: [],
          layers: [
            {
              layer: 'repo',
              file: '/w/demo/abe.yaml',
              entry: 'plain',
              written: ['keep PRs small'],
              reason: null,
              applied: true,
            },
            {
              layer: 'individual',
              file: '/me.json',
              entry: 'plain',
              written: ['write the test first'],
              reason: null,
              applied: true,
            },
          ],
        },
      },
    });

    expect(d.props.along).toEqual([
      '+ standing · keep PRs small · the repo',
      '+ standing · write the test first · yours',
    ]);
    const e = open().send({
      kind: 'result',
      id: 'launch:standing:102',
      command: null,
      reply: { ok: false, error: { code: 'offline', message: 'serve is not up' } },
    });

    expect(e.props.along).toEqual([]);
  });

  test('typing writes, ⇧⏎ a new line, ⏎ hands it back', () => {
    const d = open()
      .type('use the existing price helper')
      .keys('<S-CR>')
      .type("don't add a dependency");

    expect(d.props.draft).toBe("use the existing price helper\ndon't add a dependency");
    d.keys('<CR>');
    expect(d.tree).toBeUndefined();
    expect(d.choices()).toEqual([
      {
        kind: 'choice',
        menu: 'launchbox:102',
        row: 'launch',
        values: ["use the existing price helper\ndon't add a dependency", '', '', ''],
      },
    ]);
  });

  test('a click on Launch launches', () => {
    const d = open().send({ kind: 'click', id: 'launch:go' });

    expect(d.choices()).toEqual([
      { kind: 'choice', menu: 'launchbox:102', row: 'launch', values: ['', '', '', ''] },
    ]);
  });

  test('Esc keeps the draft for that card until it launches', () => {
    const d = open().type('price helper').keys('<Esc>');

    expect(d.tree).toBeUndefined();
    expect(d.choices()).toEqual([]);
    // another card's box starts empty
    d.send({ ...ON, id: 'launchbox:7', card: 7, title: 'Other' });
    expect(d.props.draft).toBe('');
    d.keys('<Esc>');
    // back on the first: the draft is there; launched, the next box is empty
    d.send(ON);
    expect(d.props.draft).toBe('price helper');
    d.keys('<CR>').send(ON);
    expect(d.props.draft).toBe('');
  });

  test('a screen’s menu over the box keeps its draft for the card', () => {
    const d = open().type('price helper');

    d.send({ kind: 'menu', id: 'card:102', title: '#102', rows: [] });
    expect(d.tree?.kind).toBe('PickLayer');
    d.keys('<Esc>').send(ON);
    expect(d.props.draft).toBe('price helper');
  });

  test('the count shows from 1500 characters; past 2000 it is over and ⏎ launches nothing', () => {
    const d = open().type('x'.repeat(1499));

    expect(d.props.count).toBeUndefined();
    d.type('x');
    expect(d.props.count).toBe('1500 / 2000');
    expect(d.props.over).toBeUndefined();
    d.type('x'.repeat(501));
    expect(d.props).toMatchObject({ count: '2001 / 2000', over: true });
    d.keys('<CR>');
    expect(d.choices()).toEqual([]);
    expect(d.tree?.kind).toBe('LaunchBox');
    d.keys('<BS>', '<CR>');
    expect(d.choices()).toHaveLength(1);
  });

  test('a ⏎ just after it opened, or a held one, launches nothing (#313, #285)', () => {
    const tick = (ms: number): Input => ({
      kind: 'tick',
      at: new Date(Date.parse('2026-10-25T09:00:00.000Z') + ms).toISOString(),
    });
    const layer = mountLayer(commandMode(WORDS));
    const out: Command[] = [];
    const send = (...inputs: Input[]) => {
      for (const i of inputs) out.push(...layer.send(i));
    };

    send(tick(0), ON);
    // the ⏎ that chose Launch agent… repeats: nothing, each one keeping the wait going
    send(tick(100), { kind: 'key', key: '<CR>' }, tick(450), { kind: 'key', key: '<CR>' });
    send(tick(800), { kind: 'key', key: '<CR>' });
    expect(out.filter((c) => c.kind === 'choice')).toEqual([]);
    expect(layer.tree?.kind).toBe('LaunchBox');
    // a ⏎ once it rested launches
    send(tick(1400), { kind: 'key', key: '<CR>' });
    expect(out.filter((c) => c.kind === 'choice')).toHaveLength(1);
  });

  test('opened with a draft (a launch the screen refused): the note, workflow and where are back', () => {
    const d = open()
      .keys('<Esc>')
      .send({ ...ON, draft: { note: 'the note', workflow: 'spike', runs: 'cloud' } })
      .keys('<CR>');

    expect(d.choices().at(-1)?.values).toEqual(['the note', 'spike', 'cloud', '']);
  });

  test('the workflows read: grouped Repo’s, Yours, Abe’s, preselected by on: with why; ↑↓ picks, a mismatch warns and still launches it', () => {
    const d = open()
      .keys('<Esc>')
      .send({ ...ON, type: 'Bug', tags: ['cart'], target: 'cloud' })
      .send(listed());

    expect(d.props.workflows).toEqual({
      rows: [
        { kind: 'head', text: 'Repo’s' },
        item('docs-only', 'Docs only', 'tags docs', false, false),
        item('quick-fix', 'Quick fix', 'type Bug', true, true),
        { kind: 'head', text: 'Yours' },
        item('spike', 'Spike', 'tags spike', false, false),
        { kind: 'head', text: 'Abe’s' },
        item('feature', 'Feature', 'default', false, false),
      ],
      note: 'Preselected: Quick fix takes type Bug. Any other runs this card too.',
    });
    d.keys('<Up>');
    expect(d.props.workflows).toMatchObject({
      warn: 'Docs only takes tags docs; this is a Bug tagged cart. It still runs it.',
    });
    d.keys('<Down>', '<Down>', '<Down>', '<Down>');
    // the last one stays; Feature never warns
    expect(d.props.workflows.rows.find((r) => r.kind === 'item' && r.picked)).toMatchObject({
      id: 'feature',
    });
    expect(d.props.workflows.warn).toBeUndefined();
    d.send({ kind: 'click', id: 'launch:workflow:spike' }).keys('<CR>');
    expect(d.choices().at(-1)?.values).toEqual(['', 'spike', '', '']);
  });

  test('the preselected one untouched: serve picks it by on: too, so none is named', () => {
    const d = open().send(listed()).keys('<CR>');

    expect(d.choices().at(-1)?.values).toEqual(['', '', '', '']);
  });

  test('⌃R picks where it runs; prod is the person’s for one session, local only, with its warning', () => {
    const d = open()
      .keys('<Esc>')
      .send({ ...ON, target: 'local' });

    // where it runs, in the title too: serve's `local` (local mode, a board on this machine)
    expect([d.props.ran, d.props.title]).toEqual([
      'local-sandbox',
      'Launch #102 Show VAT under the cart total · locally',
    ]);
    expect(d.props.reach.at(-1)).toEqual({
      env: 'prod',
      label: '○ prod off',
      on: false,
      click: 'launch:prod',
    });
    d.keys('<C-p>');
    expect([d.props.reach.at(-1)?.label, d.props.prodWarn]).toEqual([
      '● prod on · this session',
      'Prod on for this session alone: its agents reach prod in full, read and write. The repo’s settings stay as they are.',
    ]);
    // a box: prod is not turned on here, and none goes with the launch
    d.keys('<C-r>');
    expect([d.props.ran, d.props.reach.at(-1)?.label, d.props.prodWarn, d.props.title]).toEqual([
      'cloud',
      '○ prod off · on for one session only locally',
      undefined,
      'Launch #102 Show VAT under the cart total · on a box',
    ]);
    d.send({ kind: 'click', id: 'launch:runs:local-sandbox' }).keys('<CR>');
    expect(d.choices().at(-1)?.values).toEqual(['', '', 'local-sandbox', 'prod']);
  });

  test('the environments as the repo’s settings say; Esc keeps the workflow and where, never prod', () => {
    const d = open()
      .keys('<Esc>')
      .send({ ...ON, target: 'local-sandbox' })
      .send(got('dev', false))
      .send(got('prod', true));

    expect(d.props.reach.map((r) => r.label)).toEqual(['○ dev off', '✓ test', '✓ prod']);
    // prod on already: nothing to turn on
    d.keys('<C-p>');
    expect(d.props.prodWarn).toBeUndefined();
    d.send(got('prod', false)).keys('<C-p>', '<C-r>', '<Esc>');
    d.send({ ...ON, target: 'local-sandbox' });
    expect([d.props.ran, d.props.reach.at(-1)?.label]).toEqual([
      'cloud',
      '○ prod off · on for one session only locally',
    ]);
  });
});

const source = (
  id: string,
  layer: WorkflowSource['layer'],
  name: string,
  description: string,
  on: unknown,
): WorkflowSource => ({
  id,
  layer,
  file: `/r/.abe/workflows/${id}.yaml`,
  read: { doc: { name, description, on, steps: ['implement'] } },
});

const SOURCES: WorkflowSource[] = [
  source('quick-fix', 'repo', 'Quick fix', 'bug-like', { type: 'Bug' }),
  source('docs-only', 'repo', 'Docs only', 'Docs.', { tags: ['docs'] }),
  source('spike', 'yours', 'Spike', 'Try it.', { tags: ['spike'] }),
  source('feature', 'built-in', 'Feature', 'Any card.', 'default'),
];

/** `workflow list` answered for the box on #102. */
const listed = (): Input => ({
  kind: 'result',
  id: 'launch:workflows:102',
  command: 'workflow list',
  reply: { ok: true, data: { ...loadWorkflows({ sources: SOURCES, skills: [] }) } },
});

const DESCS: Readonly<Record<string, string>> = {
  'quick-fix': 'bug-like',
  'docs-only': 'Docs.',
  spike: 'Try it.',
  feature: 'Any card.',
};

const item = (
  id: string,
  name: string,
  on: string,
  takes: boolean,
  picked: boolean,
): LaunchWorkflowRow => ({
  kind: 'item',
  id,
  name,
  desc: DESCS[id] ?? '',
  on,
  takes,
  picked,
});

/** `settings get agents.<env>` answered. */
const got = (env: string, value: boolean): Input => ({
  kind: 'result',
  id: `launch:reach-${env}:102`,
  command: 'settings get',
  reply: {
    ok: true,
    data: { key: `agents.${env}`, value, layer: 'individual', lowered: null, problems: [] },
  },
});
