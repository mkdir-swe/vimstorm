import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  entriesOfLine,
  factoryLaunchPrompt,
  type FactoryRunData,
  type FilePatch,
  launchPrompt,
  proposalText,
  type Stage,
  TranscriptEntry,
} from '@abe/core';
import { type ChangesBar, type DiffCard, type StepRow } from './chat-components';
import { Node } from '../runtime/components';
import {
  chipOf,
  clockOf,
  dividersOf,
  ids,
  type Log,
  NO_FOLDS,
  putEntries,
  reopenedDividers,
  stopsOf,
  transcriptNode,
  type Turn,
  turnsOf,
} from './transcript';

/** A real local session (slice t113b's run, redacted): its `session.transcript` events in order. */
const REPLAY = join(import.meta.dir, '..', 'fixtures', 'transcript-replay.jsonl');
const ROOT = '/home/me/projects/demo-shop-wt/2-the-cart-total-ignores-quantity';

const Batch = z.object({
  data: z.object({ from: z.number().int(), entries: z.array(TranscriptEntry) }),
});

const replayed = (): Log =>
  readFileSync(REPLAY, 'utf8')
    .trim()
    .split('\n')
    .map((l) => Batch.parse(JSON.parse(l)).data)
    .reduce<Log>((log, b) => putEntries(log, b.from, b.entries), []);

const kinds = (n: Node): string[] => [
  n.kind,
  ...(('children' in n ? n.children : undefined) ?? []).flatMap((c) => kinds(c)),
];

const isKind = <K extends Node['kind']>(n: Node, kind: K): n is Extract<Node, { kind: K }> =>
  n.kind === kind;

const find = <K extends Node['kind']>(n: Node, kind: K): Extract<Node, { kind: K }>[] => {
  const here = isKind(n, kind) ? [n] : [];

  return [
    ...here,
    ...(('children' in n ? n.children : undefined) ?? []).flatMap((c) => find(c, kind)),
  ];
};

const at = (s: number) => new Date(Date.UTC(2026, 9, 24, 10, 0, s)).toISOString();

const user = (id: string, text: string, context: string | null = null): TranscriptEntry => ({
  kind: 'user',
  id,
  at: at(0),
  agent: null,
  text,
  context,
});
const use = (id: string, tool: string, input: Record<string, string>, s = 1): TranscriptEntry => ({
  kind: 'tool-use',
  id,
  at: at(s),
  agent: null,
  tool,
  input,
});
const result = (
  id: string,
  ok: boolean,
  text: string,
  patch: FilePatch | null = null,
): TranscriptEntry => ({
  kind: 'tool-result',
  id,
  at: at(2),
  agent: null,
  ok,
  text,
  cut: 0,
  patch,
});
const said = (id: string, text: string): TranscriptEntry => ({
  kind: 'assistant-text',
  id,
  at: at(3),
  agent: null,
  text,
});

describe('entries → turns, on a real session', () => {
  const turns = turnsOf(replayed(), ROOT);

  test('a turn per message of yours: the subagent and its hand-back start none', () => {
    const firsts = turns.map((t) => t.message?.text.split('\n')[0] ?? '');

    expect(firsts).toHaveLength(2);
    expect(firsts[0]).toBe('Work on card AB#2: The cart total ignores quantity');
    expect(firsts[1]).toStartWith('Using only shell commands');
  });

  test("a turn's changes come from its git entry, relative to the worktree, with the line ⏎ opens", () => {
    expect(turns.map((t) => t.files.map((f) => [f.path, f.added, f.removed, f.line]))).toEqual([
      [['api/src/cart.ts', 1, 1, 17]],
      [
        ['README.md', 1, 0, 4],
        ['api/src/vat.ts', 1, 0, 1],
      ],
    ]);
    expect(turns[0]?.files[0]?.lines.slice(2, 5)).toEqual([
      { kind: 'context', number: 16, text: '  const subtotal = cart.lines.reduce(' },
      { kind: 'deleted', number: 17, text: '    (sum, line) => sum + line.price,' },
      {
        kind: 'inserted',
        number: 17,
        text: '    (sum, line) => sum + line.price * line.quantity,',
      },
    ]);
    expect(turns[0]?.files[0]?.abs).toBe(`${ROOT}/api/src/cart.ts`);
  });

  test('one step row per tool call of the agent, in order, with what failed', () => {
    expect(
      turns[0]?.steps.map((s) =>
        `${s.step.glyph} ${s.step.verb} ${s.step.result ?? ''}`.replace(/ · error.*$/, ''),
      ),
    ).toEqual([
      'ok Ran ',
      "failed Ran 1 failed · cart total counts each line's quantity",
      'ok Task writer · in background',
      'ok Ran 3 passed · 1 skipped',
      'failed Ran exit 255',
      'ok Ran ',
      'failed Ran exit 1',
    ]);
    expect(turns[1]?.steps.map((s) => `${s.step.verb} ${s.step.object}`)).toEqual([
      'Wrote README.md, api/src/vat.ts',
    ]);
  });

  test('a failed step keeps its output for ⏎', () => {
    const failed = turns[0]?.steps[1];

    expect(failed?.output.some((l) => l.includes('ℹ fail 1'))).toBe(true);
  });

  test('the tree: message, changes bar, diff cards, steps, then prose; older steps folded', () => {
    const tree = transcriptNode(turns, [], NO_FOLDS);

    expect(Node.parse(tree)).toEqual(tree);
    expect(tree.children.map((c) => c.kind)).toEqual([
      'ChatMessage',
      'Turn',
      'ChatMessage',
      'Turn',
    ]);
    const [, first, , last] = tree.children;

    expect(first?.kind === 'Turn' && first.children.map((c) => c.kind)).toEqual([
      'ChangesBar',
      'DiffCard',
      'StepsFold',
      'Prose',
    ]);
    expect(last?.kind === 'Turn' && last.children.map((c) => c.kind)).toEqual([
      'ChangesBar',
      'DiffCard',
      'DiffCard',
      'StepRow',
      'Prose',
    ]);
    const bars = find(tree, 'ChangesBar').map((b: ChangesBar) => b.props);

    expect(bars.map((b) => [b.files, b.added, b.removed])).toEqual([
      [1, 1, 1],
      [2, 2, 0],
    ]);
    expect(find(tree, 'StepsFold')[0]?.props.count).toBe(7);
  });

  test("only the newest turn's first diff card is open", () => {
    const cards = find(transcriptNode(turns, [], NO_FOLDS), 'DiffCard').map((c: DiffCard) => [
      c.props.path,
      c.props.folded === true,
    ]);

    expect(cards).toEqual([
      ['api/src/cart.ts', true],
      ['README.md', false],
      ['api/src/vat.ts', true],
    ]);
  });

  test('no spinner or Thinking line anywhere', () => {
    const text = JSON.stringify(transcriptNode(turns, [], NO_FOLDS));

    expect(text).not.toMatch(/Thinking|spinner|⠋/);
  });
});

describe('entries arriving', () => {
  test('a replacement of the same number swaps the entry in its place', () => {
    const hook = putEntries([], 0, [user('u1', 'go'), use('t1', 'Bash', { command: 'npm test' })]);
    const jsonl = putEntries(hook, 1, [
      use('t1', 'Bash', { command: 'npm test' }),
      result('t1', true, 'ℹ pass 3'),
    ]);

    expect(turnsOf(hook)[0]?.steps.map((s) => s.step.glyph)).toEqual(['running']);
    expect(turnsOf(jsonl)[0]?.steps.map((s) => `${s.step.glyph} ${s.step.result}`)).toEqual([
      'ok 3 passed',
    ]);
  });

  test('an AskUserQuestion draws no step row: its card in Chat (or its answered line) stands in', () => {
    const log = putEntries([], 0, [
      user('u1', 'go'),
      use('t1', 'Bash', { command: 'npm test' }),
      use('t2', 'AskUserQuestion', { question: 'Which market table?' }),
      result('t2', false, 'Asked in Abe’s Chat'),
    ]);

    expect(turnsOf(log)[0]?.steps.map((s) => s.step.verb)).toEqual(['Running']);
  });

  test("Abe's own start and reopen prompts draw no message of yours; the agent's turn stays", () => {
    const log = putEntries([], 0, [
      {
        kind: 'user',
        id: 'u1',
        at: at(0),
        agent: null,
        text: '/abe:abe',
        context: null,
        abe: true,
      },
      { kind: 'assistant-text', id: 'a1', at: at(1), agent: null, text: 'Nothing needs you.' },
    ]);
    const [turn] = turnsOf(log);

    expect(turn?.message).toBeUndefined();
    expect(turn?.prose).toEqual(['Nothing needs you.']);
  });

  test('nor while it waits for its result: no live Asking row over the card (#274)', () => {
    const log = putEntries([], 0, [
      user('u1', 'go'),
      use('t1', 'Bash', { command: 'npm test' }),
      result('t1', true, 'ok'),
      use('t2', 'AskUserQuestion', { question: 'Which market table?' }),
    ]);

    expect(turnsOf(log)[0]?.steps.map((s) => s.step.verb)).toEqual(['Ran']);
  });

  test('a question coming up, its result read, then answered: no part shows and goes again (#274, #275)', () => {
    const question = 'Which market table should the cart total read?';
    const frames = [
      [user('u1', 'go'), use('t1', 'Read', { file_path: '/w/cart.ts' }), result('t1', true, 'x')],
      // the hook's AskUserQuestion, then the JSONL's deny result at the turn's Stop
      [use('t2', 'AskUserQuestion', { question })],
      [result('t2', false, 'Asked in Abe’s Chat')],
      // the answer, typed as the next prompt, and the agent going on
      [{ ...user('u2', `Answer to "${question}": 1 The existing market table`), at: at(4) }],
      [use('t3', 'Edit', { file_path: '/w/cart.ts' }, 5)],
      [result('t3', true, '')],
    ];
    let log: Log = [];
    const shown: string[][] = frames.map((entries) => {
      log = putEntries(log, log.length, entries);
      const tree = transcriptNode(turnsOf(log, '/w'), [], NO_FOLDS);

      return [
        ...find(tree, 'StepRow'),
        ...find(tree, 'ChatMessage'),
        ...find(tree, 'StepsFold'),
        ...find(tree, 'CardLine'),
      ].map((n) => n.id ?? '');
    });

    // each frame keeps every part the one before had: nothing added, then taken away
    shown.forEach((now, i) => {
      expect((shown[i - 1] ?? []).filter((id) => !now.includes(id))).toEqual([]);
    });
    expect(shown.at(-1)).toEqual([
      ids.step('t1'),
      ids.step('t3'),
      ids.message('u1'),
      ids.answer('u2'),
    ]);
  });

  test('a hole (a number not read yet) is passed over', () => {
    const log = putEntries([], 2, [said('a', 'hello')]);

    expect(turnsOf(log).map((t) => t.prose)).toEqual([['hello']]);
  });

  test('the running step is last, with its time so far from the tick', () => {
    const log = putEntries([], 0, [
      user('u1', 'run the tests'),
      use('t1', 'Read', { file_path: '/w/api/src/cart.ts' }),
      result('t1', true, 'text'),
      use('t2', 'Bash', { command: 'npm test' }, 6),
    ]);
    const tree = transcriptNode(turnsOf(log, '/w'), [], NO_FOLDS, { now: at(10) });
    const rows = find(tree, 'StepRow').map((r: StepRow) => r.props);

    expect(rows.map((r) => [r.mark, r.verb, r.object, r.objectKind, r.time])).toEqual([
      ['good', 'Read', 'api/src/cart.ts', 'path', undefined],
      ['live', 'Running', 'npm test', 'command', '4 s'],
    ]);
  });

  test("subagents' own entries are left out", () => {
    const sub: TranscriptEntry = { ...use('s1', 'Bash', { command: 'ls' }), agent: 'abc' };
    const log = putEntries([], 0, [user('u1', 'go'), sub]);

    expect(turnsOf(log)[0]?.steps).toEqual([]);
  });

  test('prose comes after the steps, never between them', () => {
    const log = putEntries([], 0, [
      user('u1', 'go'),
      said('a1', 'First I read it.'),
      use('t1', 'Bash', { command: 'cat a.ts' }),
      result('t1', true, 'x'),
      said('a2', 'Done.'),
    ]);
    const tree = transcriptNode(turnsOf(log), [], NO_FOLDS);
    const turn = tree.children[1];

    expect(turn?.kind === 'Turn' && turn.children.map((c) => c.kind)).toEqual(['StepRow', 'Prose']);
    expect(find(tree, 'Prose')[0]?.props.markdown).toBe('First I read it.\n\nDone.');
  });
});

describe("abe improve's block among the turn's words (P4)", () => {
  const DRAFT = [
    '**Send to Abe** · a draft issue on mkdir-swe/vimstorm, not filed',
    '',
    '**Retro names a step that already passed**',
    '',
    'The retro said verify was next.',
    '',
    '- verify ended 02:53',
    '',
    "Next (for you, not to show): paste the block above as it is, then ask File it, Change it, Don't file.",
    '',
  ].join('\n');
  const SHOWN = [
    '**Send to Abe** · a draft issue on mkdir-swe/vimstorm, not filed',
    '',
    '**Retro names a step that already passed**',
    '',
    'The retro said verify was next.',
    '',
    '- verify ended 02:53',
  ].join('\n');

  test('a Send to Abe draft: its label, title and whole body shown, never its Next line', () => {
    const log = putEntries([], 0, [
      user('u1', '/abe:improve'),
      use('t1', 'Bash', { command: 'abe improve "the retro said verify"' }),
      result('t1', true, DRAFT),
      said('a1', 'File the issue as shown?'),
    ]);

    expect(turnsOf(log)[0]?.prose).toEqual([SHOWN, 'File the issue as shown?']);
  });

  test('a Fix here change: its diff fenced; pasted by the agent itself: shown once', () => {
    const text = `${proposalText({
      id: 'p-1a2b3c4d',
      wish: 'w',
      summary: 'Esc closes the tree',
      files: [{ path: 'keys.json', before: '{}\n', after: '{"<Esc>":"tree.close"}\n' }],
    })}\nNext (for you, not to show): paste it\n`;
    const log = putEntries([], 0, [
      user('u1', 'go'),
      use('t1', 'Bash', { command: 'abe improve "esc"' }),
      result('t1', true, text),
    ]);

    expect(turnsOf(log)[0]?.prose).toEqual([
      [
        '**Fix here** · your own files: Esc closes the tree',
        '',
        '```diff',
        'keys.json (changed)',
        '  - {}',
        '  + {"<Esc>":"tree.close"}',
        '```',
        '',
        'abe improve apply p-1a2b3c4d writes it; abe improve undo takes it back.',
      ].join('\n'),
    ]);
    const pasted = putEntries(log, 3, [
      said('a1', '**Fix here** · your own files: Esc closes the tree\n\n(the diff)'),
    ]);

    expect(turnsOf(pasted)[0]?.prose).toEqual([
      '**Fix here** · your own files: Esc closes the tree\n\n(the diff)',
    ]);
  });

  test('another command printing the words: only its step', () => {
    const log = putEntries([], 0, [
      user('u1', 'go'),
      use('t1', 'Bash', { command: 'cat notes.md' }),
      result('t1', true, DRAFT),
    ]);

    expect(turnsOf(log)[0]?.prose).toEqual([]);
  });
});

describe('changes from file tools when no git entry came', () => {
  // the spike's real JSONL (t113a): an Edit and a Write with their patches
  const lines = readFileSync(
    join(
      import.meta.dir,
      '..',
      '..',
      '..',
      'core',
      'src',
      'session',
      'fixtures',
      'transcript.jsonl',
    ),
    'utf8',
  )
    .trim()
    .split('\n');
  const entries = lines.flatMap(entriesOfLine);
  const turns = turnsOf(putEntries([], 0, entries));

  test("the turn's Edit and Write patches make its files, in the order first touched", () => {
    const withFiles = turns.filter((t) => t.files.length > 0);

    expect(withFiles.length).toBeGreaterThan(0);
    for (const t of withFiles)
      for (const f of t.files) {
        expect(f.lines.length).toBeGreaterThan(0);
        expect(f.added + f.removed).toBeGreaterThan(0);
        expect(f.line).toBeGreaterThan(0);
      }
  });
});

describe('diff cards over 12 lines', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `+line ${i}`);
  const patch = {
    path: '/w/a.ts',
    created: true,
    added: 30,
    removed: 0,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 30, lines }],
    cut: 0,
  };
  const log = putEntries([], 0, [
    user('u1', 'write it'),
    use('t1', 'Write', { file_path: '/w/a.ts' }),
    result('t1', true, 'ok', patch),
  ]);
  const turns = turnsOf(log, '/w');

  test('stop at 12 with show N more, a cursor stop of its own; full once asked', () => {
    const card = find(transcriptNode(turns, [], NO_FOLDS), 'DiffCard')[0];

    expect(card?.props.lines).toHaveLength(12);
    expect(card?.props.more?.count).toBe(18);
    expect(stopsOf(turns, NO_FOLDS).map((s) => s.id)).toEqual([
      ids.bar('u1'),
      ids.diff('u1', 'a.ts'),
      ids.more('u1', 'a.ts'),
      ids.step('t1'),
    ]);
    const full = { ...NO_FOLDS, full: [ids.diff('u1', 'a.ts')] };

    expect(find(transcriptNode(turns, [], full), 'DiffCard')[0]?.props.lines).toHaveLength(30);
    expect(stopsOf(turns, full).map((s) => s.kind)).toEqual(['bar', 'diff', 'step']);
  });

  test('the cursor selects its part; on show N more, that row', () => {
    const on = (cursor: string) =>
      find(transcriptNode(turns, [], { ...NO_FOLDS, cursor }), 'DiffCard')[0]?.props;

    expect(on(ids.diff('u1', 'a.ts'))?.selected).toBe(true);
    expect(on(ids.more('u1', 'a.ts'))?.more?.selected).toBe(true);
    expect(on(ids.more('u1', 'a.ts'))?.selected).toBeUndefined();
  });
});

describe('stage dividers', () => {
  const run: Pick<FactoryRunData, 'stages' | 'stage'> = {
    stage: 'review',
    stages: [
      {
        stage: 'spec',
        startedAt: at(0),
        endedAt: '2026-10-24T12:20:00.000Z',
        durationMs: 1,
        report: null,
      },
      {
        stage: 'build',
        startedAt: at(0),
        endedAt: '2026-10-24T12:41:30.000Z',
        durationMs: 1,
        report: null,
      },
    ],
  };

  test('a lane change of the run, at the time it ended', () => {
    expect(dividersOf(run).map((d) => `${d.from} → ${d.to} · ${clockOf(d.at)}`)).toEqual([
      'Spec → Build · 12:20',
      'Build → Review · 12:41',
    ]);
  });

  test('a plain step stays on the stage before it: to-tickets on Spec, playbook on Review', () => {
    const visit = (stage: Stage, minute: number) => ({
      stage,
      startedAt: at(0),
      endedAt: `2026-10-24T12:${minute}:00.000Z`,
      durationMs: 1,
      report: null,
    });
    const playbook = {
      stage: 'step' as const,
      stages: [
        visit('spec', 10),
        visit('step', 20),
        visit('build', 30),
        visit('review', 40),
        visit('verify', 50),
      ],
    };

    expect(dividersOf(playbook).map((d) => `${d.from} → ${d.to} · ${clockOf(d.at)}`)).toEqual([
      'Spec → Build · 12:20',
      'Build → Review · 12:30',
    ]);
  });

  test('an abandoned run ends in Abandoned, not Done (#229)', () => {
    const abandoned = {
      stage: 'done' as const,
      outcome: 'abandoned' as const,
      stages: [
        ...run.stages,
        {
          stage: 'pr' as const,
          startedAt: at(0),
          endedAt: '2026-10-24T13:44:00.000Z',
          durationMs: 1,
          report: null,
        },
      ],
    };

    expect(dividersOf(abandoned).map((d) => `${d.from} → ${d.to} · ${clockOf(d.at)}`)).toEqual([
      'Spec → Build · 12:20',
      'Build → PR · 12:41',
      'PR → Abandoned · 13:44',
    ]);
    // ended done: Done; ended as not reproduced: said so, never Done (#320)
    expect(dividersOf({ ...abandoned, outcome: 'done' }).at(-1)?.to).toBe('Done');
    expect(dividersOf({ ...abandoned, outcome: 'not-reproduced' }).at(-1)?.to).toBe(
      'Not reproduced',
    );
  });

  test('drawn between the turns, before the first turn after it', () => {
    const log = putEntries([], 0, [
      { ...user('u1', 'spec it'), at: '2026-10-24T12:00:00.000Z' },
      { ...user('u2', 'build it'), at: '2026-10-24T12:30:00.000Z' },
    ]);
    const tree = transcriptNode(turnsOf(log), dividersOf(run), NO_FOLDS);

    expect(kinds(tree).slice(1)).toEqual([
      'ChatMessage',
      'StageDivider',
      'ChatMessage',
      'StageDivider',
    ]);
    expect(find(tree, 'StageDivider').map((d) => d.props)).toEqual([
      { from: 'Spec', to: 'Build', at: '12:20' },
      { from: 'Build', to: 'Review', at: '12:41' },
    ]);
  });

  test("other parts' nodes: placed among the turns by time, the tail after the last turn", () => {
    const log = putEntries([], 0, [
      { ...user('u1', 'spec it'), at: '2026-10-24T12:00:00.000Z' },
      { ...user('u2', 'build it'), at: '2026-10-24T12:30:00.000Z' },
    ]);
    const line = (id: string): Node => ({
      kind: 'StageDivider',
      id,
      props: { from: id, to: id, at: '' },
    });
    const tree = transcriptNode(turnsOf(log), [], NO_FOLDS, {
      placed: [{ at: '2026-10-24T12:10:00.000Z', node: line('answered') }],
      tail: [line('open-card')],
      newBelow: 2,
    });

    expect(tree.children.map((n) => n.id)).toEqual([
      ids.message('u1'),
      'answered',
      ids.message('u2'),
      'open-card',
      ids.newBelow,
    ]);
  });

  test('one asked mid-turn sits where it was asked: before the call it held and the work after (#307)', () => {
    const log = putEntries([], 0, [
      user('u1', 'charge the test card'),
      use('t1', 'Read', { file_path: '/w/pay.ts' }, 1),
      { ...result('t1', true, 'x'), at: at(2) },
      use('t2', 'Bash', { command: 'curl -s https://api.payments.example/v1/charge' }, 3),
      { ...result('t2', true, '{}'), at: at(6) },
      use('t3', 'Read', { file_path: '/w/log.ts' }, 7),
      { ...result('t3', true, 'x'), at: at(8) },
      said('a', 'Charged the test card.'),
    ]);
    const line: Node = { kind: 'CardLine', id: 'answered:p-1', props: { head: 'Answered' } };
    const placed = [{ at: at(4), node: line }];
    const turns = turnsOf(log, '/w');
    const tree = transcriptNode(turns, [], NO_FOLDS, { placed });
    const turn = tree.children.find((n) => n.kind === 'Turn');

    expect(turn !== undefined && 'children' in turn ? turn.children.map((n) => n.id) : []).toEqual([
      ids.step('t1'),
      'answered:p-1',
      ids.step('t2'),
      ids.step('t3'),
      ids.prose('u1'),
    ]);
    // a question that ended the turn: after it, as before
    const ended = transcriptNode(turns, [], NO_FOLDS, { placed: [{ at: at(9), node: line }] });

    expect(ended.children.map((n) => n.id)).toEqual([
      ids.message('u1'),
      ids.turn('u1'),
      'answered:p-1',
    ]);
  });

  test('one asked during a later Task of a folded run goes before the row, as the run ends last (#307)', () => {
    const log = putEntries([], 0, [
      user('u1', 'go'),
      use('k1', 'Task', { description: 'look', prompt: 'p' }, 1),
      { ...result('k1', true, 'x'), at: at(2) },
      use('k2', 'Task', { description: 'look more', prompt: 'p' }, 3),
      { ...result('k2', true, 'x'), at: at(6) },
    ]);
    const line: Node = { kind: 'CardLine', id: 'answered:p-1', props: { head: 'Answered' } };
    const tree = transcriptNode(turnsOf(log), [], NO_FOLDS, {
      placed: [{ at: at(4), node: line }],
    });
    const turn = tree.children.find((n) => n.kind === 'Turn');

    expect(turn !== undefined && 'children' in turn ? turn.children.map((n) => n.id) : []).toEqual([
      'answered:p-1',
      ids.step('k1'),
    ]);
  });

  test('no run, or no lane change: none', () => {
    expect(dividersOf(undefined)).toEqual([]);
    const [spec] = run.stages;

    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(dividersOf({ stage: 'build', stages: [{ ...spec, stage: 'build' }] })).toEqual([]);
  });
});

describe('a call that never got its result', () => {
  const log = putEntries([], 0, [
    user('u1', 'first'),
    use('t1', 'Bash', { command: 'npm test' }),
    user('u2', 'second'),
    use('t2', 'Bash', { command: 'npm test' }),
  ]);
  const glyphs = (turns: Turn[]) => turns.map((t) => t.steps.map((x) => x.step.glyph));

  test('runs only in the newest turn of a live session; elsewhere it was stopped', () => {
    expect(glyphs(turnsOf(log))).toEqual([['failed'], ['running']]);
    expect(turnsOf(log)[0]?.steps[0]?.step).toMatchObject({ verb: 'Ran', result: 'stopped' });
    expect(glyphs(turnsOf(log, undefined, { live: false }))).toEqual([['failed'], ['failed']]);
  });
});

describe('your answer to a card (#275)', () => {
  const question = 'Should sign-in send a magic link?\nThe story says "sign in with email".';
  const log = putEntries([], 0, [
    user('u1', 'go'),
    use('t1', 'Read', { file_path: '/w/a.ts' }),
    result('t1', true, 'x'),
    { ...user('u2', `Answer to "${question}": 1 Magic link`), at: at(4) },
    use('t2', 'Edit', { file_path: '/w/a.ts' }, 5),
    result('t2', true, ''),
    {
      ...user('u3', `1. Answer to "${question}": 2 Password\n2. Answer to "Flag?": 1 Yes`),
      at: at(6),
    },
  ]);
  const turns = turnsOf(log, '/w');

  test('draws no message of yours: its answered line, as the card folds, in its place', () => {
    const tree = transcriptNode(turns, [], NO_FOLDS);

    expect(turns.map((t) => [t.id, t.message?.text])).toEqual([
      ['u1', 'go'],
      ['u2', undefined],
      ['u3', undefined],
    ]);
    expect(tree.children.map((n) => n.id)).toEqual([
      ids.message('u1'),
      ids.turn('u1'),
      ids.answer('u2'),
      ids.turn('u2'),
      ids.answer('u3'),
    ]);
    expect(find(tree, 'CardLine').map((l) => l.props)).toEqual([
      { head: 'Answered', text: 'Magic link', n: 1 },
      { head: 'Answered', text: 'Round 1 · 2 questions' },
    ]);
  });

  test("the card's own line gives way to it once the prompt came, in the same place", () => {
    const line: Node = {
      kind: 'CardLine',
      id: 'answered:q-1',
      props: { head: 'Answered', text: 'Magic link', n: 1 },
    };
    const asked = { at: at(3), node: line, question };
    const waiting = transcriptNode(turnsOf(log.slice(0, 3), '/w'), [], NO_FOLDS, {
      placed: [asked],
    });
    const came = transcriptNode(turns, [], NO_FOLDS, { placed: [asked] });

    expect(waiting.children.map((n) => n.id)).toEqual([
      ids.message('u1'),
      ids.turn('u1'),
      'answered:q-1',
    ]);
    expect(came.children.map((n) => n.id).slice(0, 3)).toEqual([
      ids.message('u1'),
      ids.turn('u1'),
      ids.answer('u2'),
    ]);
    // a permission's line (no prompt of its own) stays
    const kept = transcriptNode(turns, [], NO_FOLDS, { placed: [{ at: at(3), node: line }] });

    expect(kept.children.map((n) => n.id)).toContain('answered:q-1');
  });

  test("only its own answer takes a card's line: a card asked after it keeps its line", () => {
    const other: Node = { kind: 'CardLine', id: 'answered:q-2', props: { head: 'Answered' } };
    const tree = transcriptNode(turns, [], NO_FOLDS, {
      placed: [{ at: at(3), node: other, question: 'Which market table?' }],
    });

    expect(tree.children.map((n) => n.id)).toContain('answered:q-2');
  });

  test('the turn that asked stays open: its steps do not fold to `N steps`', () => {
    const tree = transcriptNode(turns, [], NO_FOLDS);

    expect(find(tree, 'StepsFold')).toEqual([]);
    expect(stopsOf(turns, NO_FOLDS).map((s) => s.id)).toEqual([ids.step('t1'), ids.step('t2')]);
  });

  test('it holds the room a folded card leaves until a message of yours (#311)', () => {
    const more = turnsOf(
      putEntries(log, log.length, [{ ...user('u4', 'now the tests'), at: at(7) }]),
    );
    const asking = turnsOf(log.slice(0, 3), '/w');
    const line: Node = { kind: 'CardLine', id: 'answered:q-1', props: { head: 'Answered' } };

    expect(transcriptNode(turns, [], NO_FOLDS).props.hold).toBe(true);
    expect(transcriptNode(more, [], NO_FOLDS).props.hold).toBeUndefined();
    // answered, its prompt not in yet: held already
    expect(transcriptNode(asking, [], NO_FOLDS).props.hold).toBeUndefined();
    expect(
      transcriptNode(asking, [], NO_FOLDS, { placed: [{ at: at(3), node: line, question }] }).props
        .hold,
    ).toBe(true);
  });

  test('a message of yours after it folds them all as before', () => {
    const more = turnsOf(
      putEntries(log, log.length, [{ ...user('u4', 'now the tests'), at: at(7) }]),
    );

    expect(stopsOf(more, NO_FOLDS).map((s) => s.id)).toEqual([ids.steps('u1'), ids.steps('u2')]);
  });
});

describe('the context chip', () => {
  test.each([
    ['api/src/cart.ts lines 12–18', '@api/src/cart.ts#L12-18'],
    ['api/src/cart.ts, caret on line 16', '@api/src/cart.ts:16'],
    ['story #2 The cart total ignores quantity', '#2 The cart total ignores quantity · story'],
    ['something else', 'something else'],
  ])('%s → %s', (context, chip) => {
    expect(chipOf(context)).toBe(chip);
  });

  test('your message carries it, dim at its top', () => {
    const log = putEntries([], 0, [user('u1', 'why?', 'api/src/cart.ts lines 12–18')]);

    expect(find(transcriptNode(turnsOf(log), [], NO_FOLDS), 'ChatMessage')[0]?.props).toEqual({
      text: 'why?',
      context: '@api/src/cart.ts#L12-18',
    });
  });
});

describe('the launch prompt as your first message (#308)', () => {
  const PROMPT = [
    'Work on card AB#4: As a visitor I can sign in with email',
    '',
    '### Why',
    '',
    '- email + password, *no* `Sign in` with Google',
    '',
    '## Acceptance criteria',
    '',
    '- A wrong password says so',
  ].join('\n');
  const shown = (text: string) =>
    find(
      transcriptNode(turnsOf(putEntries([], 0, [user('u1', text)])), [], NO_FOLDS),
      'ChatMessage',
    )[0]?.props;

  test('one line, the card sent along as its story chip: no markdown marks', () => {
    expect(shown(PROMPT)).toEqual({
      text: 'Work on card AB#4: As a visitor I can sign in with email',
      context: '#4 As a visitor I can sign in with email · story',
    });
  });

  test("a board on this machine's card (L-4): the same", () => {
    expect(shown(`/abe:factory ${PROMPT.replace('AB#4', 'L-4')}`)).toEqual({
      text: 'Work on card L-4: As a visitor I can sign in with email',
      context: '#4 As a visitor I can sign in with email · story',
    });
  });

  test('your Launch note under its first line, the standing notes one quiet line (#347)', () => {
    const notes = [
      '',
      '## Notes from Ada Example',
      'use the existing price helper',
      "don't add a dependency",
      '',
      '## Standing notes',
      '- write the test first (yours)',
      '- keep PRs small (the repo)',
    ].join('\n');

    expect(shown(`/abe:factory ${PROMPT}\n${notes}\n\nThe person asked to just build: x`)).toEqual({
      text: [
        'Work on card AB#4: As a visitor I can sign in with email',
        '',
        "use the existing price helper\ndon't add a dependency",
        '',
        '_+ 2 standing notes_',
      ].join('\n'),
      context: '#4 As a visitor I can sign in with email · story',
    });
    // a description with headings of its own is the card's; a note-only prompt has no story chip
    const own = [
      'Work on card AB#4: Show VAT',
      '',
      '## Notes from the workshop',
      '- VAT under the total',
      '',
      '## Standing notes',
      '- nothing here is a standing note',
      '',
      '## Notes from Ada Example',
      'The person asked me twice',
    ].join('\n');

    expect(shown(own)).toEqual({
      text: 'Work on card AB#4: Show VAT\n\nThe person asked me twice',
      context: '#4 Show VAT · story',
    });
    expect(shown('Work on card AB#4: Show VAT\n\n## Notes from Ada Example\nhi')).toEqual({
      text: 'Work on card AB#4: Show VAT\n\nhi',
    });
    // a prototype's reference after the note is not the note (#351)
    expect(
      shown(
        'Work on card AB#4: Show VAT\n\n## Notes from Ada Example\nhi\n\n## Prototype (a question, not a spec)\nv1 in .scratch/4/prototype',
      )?.text,
    ).toBe('Work on card AB#4: Show VAT\n\nhi');
    // standing notes alone: only their line
    expect(shown(`${PROMPT}\n\n## Standing notes\n- write the test first (yours)`)?.text).toBe(
      'Work on card AB#4: As a visitor I can sign in with email\n\n_+ 1 standing note_',
    );
  });

  test("a Factory run's: no skill command before it", () => {
    expect(shown(`/abe:factory ${PROMPT}`)).toEqual({
      text: 'Work on card AB#4: As a visitor I can sign in with email',
      context: '#4 As a visitor I can sign in with email · story',
    });
    // a launch on a card with no description: the line alone
    expect(shown('/abe:factory Work on card AB#5: Reset my password')).toEqual({
      text: 'Work on card AB#5: Reset my password',
    });
  });

  test("core's own launch prompts, as it writes them, read the same", () => {
    const card = {
      id: 4,
      title: 'As a visitor I can sign in with email',
      description: '### Why\n\n- email + password',
      acceptanceCriteria: '- A wrong password says so',
    };
    const one = {
      text: 'Work on card AB#4: As a visitor I can sign in with email',
      context: '#4 As a visitor I can sign in with email · story',
    };

    expect(shown(launchPrompt(card))).toEqual(one);
    expect(shown(factoryLaunchPrompt(card))).toEqual(one);
  });

  test('what you type stays as you typed it, a slash command too', () => {
    expect(shown('/compact')).toEqual({ text: '/compact' });
    expect(shown('### keep this\n- as is')).toEqual({ text: '### keep this\n- as is' });
  });
});

describe('cursor stops and folds', () => {
  const log = putEntries([], 0, [
    user('u1', 'one'),
    use('t1', 'Bash', { command: 'ls' }),
    result('t1', true, 'a'),
    user('u2', 'two'),
    use('t2', 'Bash', { command: 'ls' }),
    result('t2', true, Array.from({ length: 20 }, (_, i) => `out ${i}`).join('\n')),
  ]);
  const turns = turnsOf(log);

  test('an earlier turn is one `N steps` stop; opened, its rows', () => {
    expect(stopsOf(turns, NO_FOLDS).map((s) => s.id)).toEqual([ids.steps('u1'), ids.step('t2')]);
    expect(stopsOf(turns, { ...NO_FOLDS, opened: ['u1'] }).map((s) => s.id)).toEqual([
      ids.step('t1'),
      ids.step('t2'),
    ]);
  });

  test('an unfolded step shows at most 10 lines of its output, then `show N more` (#343)', () => {
    const unfolded = { ...NO_FOLDS, unfolded: [ids.step('t2')] };
    const tree = transcriptNode(turns, [], unfolded);
    const row = find(tree, 'StepRow')[0];

    expect(row?.props.output).toHaveLength(10);
    expect(row?.props.more).toEqual({ count: 10, id: `${ids.step('t2')}:more` });
    // the row is a stop after the step's own; ⏎ there is the full output (`full`)
    expect(stopsOf(turns, unfolded).map((s) => s.id)).toEqual([
      ids.steps('u1'),
      ids.step('t2'),
      `${ids.step('t2')}:more`,
    ]);
    const cursor = { ...unfolded, cursor: `${ids.step('t2')}:more` };

    expect(find(transcriptNode(turns, [], cursor), 'StepRow')[0]?.props.more).toMatchObject({
      selected: true,
    });
    const full = { ...unfolded, full: [ids.step('t2')] };

    expect(find(transcriptNode(turns, [], full), 'StepRow')[0]?.props.output).toHaveLength(20);
    expect(stopsOf(turns, full).map((s) => s.id)).not.toContain(`${ids.step('t2')}:more`);
  });

  test('a reopened session marks where its conversation went on (#343)', () => {
    const later = new Date(Date.parse(turns[1]?.at ?? '') + 1000).toISOString();
    const tree = transcriptNode(turns, reopenedDividers({ reopened: [later] }), NO_FOLDS);
    const divider = find(tree, 'StageDivider')[0];

    expect(divider).toMatchObject({
      id: 'reopened:0',
      props: { from: 'Reopened', to: '' },
    });
    expect(reopenedDividers({})).toEqual([]);
    // the next day it is dated: `Reopened 26 Oct 09:14`, as the clock in this zone reads it
    const at = new Date(2026, 9, 26, 9, 14).toISOString();
    const dated = (now: string) =>
      find(
        transcriptNode(turns, reopenedDividers({ reopened: [at] }), NO_FOLDS, { now }),
        'StageDivider',
      )[0]?.props.at;

    expect(dated(new Date(2026, 9, 27, 8, 0).toISOString())).toBe('26 Oct 09:14');
    expect(dated(new Date(2026, 9, 26, 10, 0).toISOString())).toBe('09:14');
  });

  test('`↓ N new` is the last stop while it shows', () => {
    expect(stopsOf(turns, NO_FOLDS, { newBelow: true }).at(-1)?.id).toBe(ids.newBelow);
    expect(
      find(transcriptNode(turns, [], NO_FOLDS, { newBelow: 3 }), 'NewBelow')[0]?.props,
    ).toEqual({ count: 3 });
  });
});
