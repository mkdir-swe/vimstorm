import { describe, expect, test } from 'bun:test';
import { checkHolds, parseCheck } from './expr';
import {
  loadWorkflows,
  runWorkflowOf,
  type SkillSource,
  type SkillView,
  type WorkflowProblemCode,
  type WorkflowSource,
} from './load';
import { launchChoices, mismatchWords } from './launch-pick';
import { pickedWorkflow, workflowFor } from './pick';
import { FEATURE_WORKFLOW } from './run';

const src = (doc: unknown, o: Partial<Omit<WorkflowSource, 'read'>> = {}): WorkflowSource => ({
  layer: 'yours',
  file: `/c/workflows/${o.id ?? 'w'}.yaml`,
  id: 'w',
  read: { doc },
  ...o,
});
const skills = [{ name: 'reproduce', layer: 'repo' as const }];
const load = (...sources: WorkflowSource[]) => loadWorkflows({ sources, skills });
const W = (o: Record<string, unknown> = {}) => ({
  name: 'Quick fix',
  steps: ['reproduce', 'implement', 'code-review', 'verify', 'pr'],
  ...o,
});
const loop = (o: Record<string, unknown> = {}) => ({
  from: 'code-review',
  to: 'implement',
  when: { check: 'review.findings.high > 0' },
  max: 2,
  ...o,
});

describe('the load check: each file problem by its code', () => {
  test.each<[string, unknown, WorkflowProblemCode[]]>([
    ['a good file', W({ loops: [loop()] }), []],
    ['no name', { steps: ['implement'] }, ['schema']],
    ['an unknown key', W({ stpes: [] }), ['schema']],
    ['a skill no Layer has', W({ steps: ['repro', 'implement'] }), ['unknown-skill']],
    ['a step twice', W({ steps: ['implement', 'implement'] }), ['duplicate-step']],
    [
      'review and code-review both',
      W({ steps: ['implement', 'review', 'code-review'] }),
      ['duplicate-step'],
    ],
    ['pr not last', W({ steps: ['implement', 'pr', 'reproduce'] }), ['pr-last']],
    [
      'verify before any build',
      W({ steps: ['reproduce', 'verify', 'implement'] }),
      ['needs-build'],
    ],
    ['checks with no build at all', W({ steps: ['checks'] }), ['needs-build']],
    ['a loop from a step not here', W({ loops: [loop({ from: 'triage' })] }), ['loop-step']],
    ['a loop forward', W({ loops: [loop({ from: 'implement', to: 'verify' })] }), ['loop-forward']],
    ['a loop with no max', W({ loops: [loop({ max: undefined })] }), ['no-max']],
    [
      'a when with both kinds',
      W({
        loops: [loop({ when: { check: 'review.findings > 0', judge: 'Any?', sees: ['diff'] } })],
      }),
      ['both-kinds'],
    ],
    ['a when with neither', W({ loops: [loop({ when: {} })] }), ['schema']],
    ['a judge with no sees', W({ loops: [loop({ when: { judge: 'Any?' } })] }), ['judge-sees']],
    [
      'a judge that is no question',
      W({ loops: [loop({ when: { judge: 'Look', sees: ['diff'] } })] }),
      ['judge-question'],
    ],
    [
      'a check that does not read',
      W({ loops: [loop({ when: { check: 'review.findings >' } })] }),
      ['bad-check'],
    ],
    [
      'a check over a fact no step reports',
      W({ loops: [loop({ when: { check: 'pr.cats > 0' } })] }),
      ['unknown-fact'],
    ],
    [
      'a check comparing text',
      W({ loops: [loop({ when: { check: 'checks.output > 0' } })] }),
      ['text-fact'],
    ],
    [
      'a done_when over a fact its step does not report',
      W({ steps: [{ reproduce: { done_when: { check: 'criteria.failed == 0' } } }, 'implement'] }),
      ['unknown-fact'],
    ],
    [
      'a done_when over its reports',
      W({
        steps: [
          { reproduce: { reports: ['seen'], done_when: { check: 'seen > 0' } } },
          'implement',
        ],
      }),
      [],
    ],
    ['a pin by its own Layer', W({ steps: [{ implement: { pin: 'yours' } }] }), []],
    [
      'a step naming its main skill, fresh, gated on the diff, ending with its report',
      W({
        steps: [
          {
            reproduce: {
              skill: 'reproduce',
              ends: { check: 'bug.reproduced == 0', then: 'report' },
            },
          },
          { build: { skill: 'implement', fresh: 'loop' } },
          'checks',
          { review: { skill: 'code-review', fresh: true } },
          { playbook: { skill: 'reproduce', when: { judge: 'Manual steps?', sees: ['diff'] } } },
          'pr',
        ],
      }),
      [],
    ],
    [
      'a main skill no Layer has',
      W({ steps: [{ implement: { skill: 'implemnt' } }] }),
      ['unknown-skill'],
    ],
    [
      'checks with a skill',
      W({ steps: ['implement', { checks: { skill: 'reproduce' } }] }),
      ['checks-skill'],
    ],
    ['fresh that is no mode', W({ steps: [{ implement: { fresh: 'always' } }] }), ['schema']],
    [
      'a gate seeing what it may not',
      W({ steps: ['implement', { reproduce: { when: { judge: 'Any?', sees: ['logs'] } } }] }),
      ['gate-sees'],
    ],
    [
      'a gate over a fact no step before reports',
      W({ steps: [{ reproduce: { when: { check: 'review.findings > 0' } } }, 'implement'] }),
      ['unknown-fact'],
    ],
    [
      'a gate with both kinds',
      W({
        steps: [
          'implement',
          { reproduce: { when: { check: 'checks.failed > 0', judge: 'Any?', sees: ['diff'] } } },
        ],
      }),
      ['both-kinds'],
    ],
    ['ends always', W({ steps: [{ reproduce: { ends: { then: 'report' } } }] }), []],
    [
      'ends with both kinds',
      W({ steps: [{ reproduce: { ends: { check: 'seen > 0', judge: 'Any?', then: 'report' } } }] }),
      ['both-kinds', 'judge-sees', 'unknown-fact'],
    ],
    [
      'ends over a fact no step reports',
      W({ steps: [{ reproduce: { ends: { check: 'criteria.failed > 0', then: 'report' } } }] }),
      ['unknown-fact'],
    ],
    [
      'ends then anything but report',
      W({ steps: [{ reproduce: { ends: { then: 'pr' } } }] }),
      ['schema'],
    ],
    [
      "a pr into the branch a step before reports (a teammate's head)",
      W({
        steps: [
          { reproduce: { reports: ['audit.head'] } },
          'implement',
          { pr: { into: 'audit.head' } },
        ],
      }),
      [],
    ],
    [
      'into on a step that opens no pull request',
      W({
        steps: [{ reproduce: { reports: ['audit.head'] } }, { implement: { into: 'audit.head' } }],
      }),
      ['into-step'],
    ],
    [
      'into a fact no step before reports',
      W({ steps: ['reproduce', 'implement', { pr: { into: 'audit.head' } }] }),
      ['into-fact'],
    ],
    [
      'into a count',
      W({ steps: ['reproduce', 'implement', 'checks', { pr: { into: 'checks.failed' } }] }),
      ['into-fact'],
    ],
    ['into that is no name', W({ steps: ['implement', { pr: { into: '' } }] }), ['schema']],
  ])('%s', (_, doc, codes) => {
    expect(load(src(doc)).problems.map((p) => p.code)).toEqual(codes);
  });

  test("a skill whose copy the repo deleted: Abe's is not in force there, so no Layer has it", () => {
    const d = loadWorkflows({ sources: [src(W())], skills, builtIn: ['factory'] });

    expect(d.problems.map((p) => p.code)).toContain('unknown-skill');
  });

  test('a pin by a Layer nearer than its file is refused', () => {
    const d = load(src(W({ steps: [{ implement: { pin: 'yours' } }] }), { layer: 'repo' }));

    expect(d.problems.map((p) => p.code)).toEqual(['pin-nearer']);
  });

  test("YAML that does not read: can't read, line N; not offered", () => {
    const d = load({ ...src(null), read: { error: 'bad indentation', line: 7 } });

    expect([d.problems[0]?.text, d.problems[0]?.line, d.workflows[0]?.inForce]).toEqual([
      "Can't read w.yaml: line 7: bad indentation",
      7,
      false,
    ]);
  });

  test.each<[string, unknown, string]>([
    ['on: tags as text', W({ on: { tags: 'qa' } }), 'tags: takes a list of tags: [qa], not text'],
    [
      'on: as a number',
      W({ on: 3 }),
      'on: takes a card type (on: bug), default, or { type: bug, tags: [qa] }',
    ],
    [
      'a key on: has not',
      W({ on: { tyep: 'bug' } }),
      "tyep: isn't a key of on:; it takes type, tags",
    ],
    [
      'fresh: no mode',
      W({ steps: [{ reproduce: { fresh: 'always' } }] }),
      'fresh: takes true, false or loop',
    ],
    ['no name', { steps: ['reproduce'] }, 'name: is missing: it takes text'],
    ['a file not a map', 'hello', 'The file takes a map: name:, steps: and the rest, not text'],
  ])('a schema problem in plain words: %s', (_, doc, text) => {
    expect(load(src(doc)).problems.map((p) => p.text)).toEqual([text]);
  });

  test("a problem's line is its node's, from the source", () => {
    const d = load({
      ...src(W({ steps: ['repro', 'implement'] })),
      lineOf: (p) => (p[0] === 'steps' ? 6 + Number(p[1]) : null),
    });

    expect([d.problems[0]?.line, d.problems[0]?.text]).toEqual([
      6,
      'No skill named repro in any Layer',
    ]);
  });
});

describe('Layers: nearest wins, pins kept', () => {
  const org = src(
    W({ steps: [{ reproduce: { pin: 'repo' } }, 'implement', { verify: { pin: 'repo' } }, 'pr'] }),
    { layer: 'repo' },
  );

  test.each<[string, unknown, WorkflowProblemCode[]]>([
    [
      'a copy keeping the pins, adding around them',
      W({ steps: ['reproduce', 'implement', 'code-review', 'verify', 'pr'] }),
      [],
    ],
    ['a copy dropping one', W({ steps: ['implement', 'pr'] }), ['pin-dropped', 'pin-dropped']],
    [
      'a copy reordering them',
      W({ steps: ['implement', 'reproduce'], loops: [] }),
      ['pin-dropped'],
    ],
  ])('%s', (_, doc, codes) => {
    expect(load(src(doc), org).workflows[0]?.problems.map((p) => p.code)).toEqual(codes);
  });

  test('the nearest ok file is in force; a farther one is shadowed; a failing nearest runs nothing', () => {
    const good = load(src(W()), org);
    const bad = load(src(W({ steps: ['repro'] })), org);

    expect(good.workflows.map((w) => [w.layer, w.inForce, w.shadows])).toEqual([
      ['yours', true, ['repo']],
      ['repo', false, []],
    ]);
    expect(bad.workflows.map((w) => w.inForce)).toEqual([false, false]);
  });

  test('a step as the view and the run carry it: its main skill, fresh, gate and ends', () => {
    const d = load(
      src(
        W({
          steps: [
            { reproduce: { ends: { check: 'bug.reproduced == 0', then: 'report' } } },
            { build: { skill: 'implement', fresh: 'loop' } },
            { review: { fresh: true } },
            { playbook: { skill: 'reproduce', when: { judge: 'Manual steps?', sees: ['diff'] } } },
            'pr',
          ],
        }),
      ),
    );
    const w = d.workflows[0];

    expect(w?.steps.map((s) => [s.name, s.kind, s.skill, s.fresh])).toEqual([
      ['reproduce', 'reproduce', 'reproduce', 'never'],
      ['build', 'build', 'implement', 'loop'],
      ['review', 'review', 'code-review', 'always'],
      ['playbook', 'step', 'reproduce', 'never'],
      ['pr', 'pr', 'pr', 'never'],
    ]);
    expect([w?.steps[0]?.ends, w?.steps[3]?.gate]).toEqual([
      {
        when: { kind: 'check', check: 'bug.reproduced == 0', facts: ['bug.reproduced'] },
        then: 'report',
      },
      { kind: 'judge', question: 'Manual steps?', sees: ['diff'] },
    ]);
    const run = w === undefined ? undefined : runWorkflowOf(w);

    expect(run?.steps.map((s) => [s.name, s.skill, s.fresh, s.when, s.ends])).toEqual([
      [
        'reproduce',
        'reproduce',
        'never',
        null,
        { when: { check: 'bug.reproduced == 0' }, then: 'report' },
      ],
      ['build', 'implement', 'loop', null, null],
      ['review', 'code-review', 'always', null, null],
      ['playbook', 'reproduce', 'never', { judge: 'Manual steps?', sees: ['diff'] }, null],
      ['pr', 'pr', 'never', null, null],
    ]);
    expect(run?.steps.map((s) => s.into)).toEqual([null, null, null, null, null]);
  });

  test("a pr step's into: as the view and the run carry it", () => {
    const w = load(
      src(
        W({
          steps: [
            { reproduce: { reports: ['audit.head'] } },
            'implement',
            { pr: { skill: 'pr', fresh: true, into: 'audit.head' } },
          ],
        }),
      ),
    ).workflows[0];

    expect([w?.ok, w?.steps.at(-1)?.into]).toEqual([true, 'audit.head']);
    expect(w === undefined ? undefined : runWorkflowOf(w).steps.at(-1)?.into).toBe('audit.head');
  });

  test('checks, review and verify with no loop of their own go back to the nearest build before', () => {
    const d = load(src(W()));

    expect(d.workflows[0]?.loops.map((l) => [l.id, l.from, l.to, l.max, l.implied])).toEqual([
      ['1', 'code-review', 'implement', 2, true],
      ['2', 'verify', 'implement', 10, true],
    ]);
  });
});

describe("skills: each Layer's folder, the nearest of a name in force, what uses it", () => {
  const sk = (name: string, layer: SkillSource['layer'], o: Partial<SkillSource> = {}) => ({
    name,
    layer,
    ...o,
  });
  const d = loadWorkflows({
    sources: [src(W()), src(W({ steps: ['repro'] }), { id: 'broken' })],
    skills: [
      sk('reproduce', 'repo'),
      sk('reproduce', 'yours', {
        dir: '/c/skills/reproduce',
        description: 'Repro it',
        files: ['SKILL.md'],
      }),
      sk('implement', 'built-in'),
      sk('seed', 'repo'),
    ],
  });

  test.each<[string, (k: SkillView) => unknown, unknown[]]>([
    [
      'nearest Layer first, then by name',
      (k) => [k.layer, k.name],
      [
        ['yours', 'reproduce'],
        ['repo', 'reproduce'],
        ['repo', 'seed'],
        ['built-in', 'implement'],
      ],
    ],
    [
      'the nearest of a name in force, shadowing the farther',
      (k) => [k.inForce, k.shadows],
      [
        [true, ['repo']],
        [false, []],
        [true, []],
        [true, []],
      ],
    ],
    ['used by the in-force workflows whose step runs it', (k) => k.usedBy, [['w'], [], [], ['w']]],
    [
      "its folder, description and files as the ports read them; a built-in's folder",
      (k) => [k.dir, k.description, k.files],
      [
        ['/c/skills/reproduce', 'Repro it', ['SKILL.md']],
        ['', '', []],
        ['', '', []],
        ['built-in/skills/implement', '', []],
      ],
    ],
  ])('%s', (_, pick, want) => {
    expect(d.skills.map(pick)).toEqual(want);
  });
});

describe('which workflow a card runs', () => {
  const bug = src(W({ on: 'bug' }), { id: 'quick-fix' });
  const tagged = src(W({ on: { type: ['User Story'], tags: ['tiny'] } }), {
    id: 'tiny',
    layer: 'repo',
  });
  const factory = src(W({ name: 'Factory', on: 'default' }), { id: 'factory', layer: 'built-in' });

  test.each<[string, { type: string; tags: string[] }, string]>([
    ['its type, any case', { type: 'Bug', tags: [] }, 'quick-fix'],
    ['type and tag both', { type: 'User Story', tags: ['Tiny'] }, 'tiny'],
    [
      'the type without the tag: Feature, Abe’s default',
      { type: 'User Story', tags: [] },
      'feature',
    ],
  ])('%s', (_, card, id) => {
    expect(workflowFor(card, load(bug, tagged)).id).toBe(id);
  });

  test('the launch offers each card workflow, Repo’s then Yours then Abe’s, one preselected and why', () => {
    const docs = src(W({ name: 'Docs only', description: 'Docs.', on: { tags: ['docs'] } }), {
      id: 'docs-only',
      layer: 'repo',
    });
    const loaded = load(bug, tagged, docs, factory, src(W({ name: 'Spike' }), { id: 'spike' }));
    const choices = launchChoices({ type: 'Bug', tags: ['cart'] }, loaded);

    // a workflow with no on: is offered, never preselected
    expect(choices.options.map((o) => [o.id, o.layer, o.on, o.takes])).toEqual([
      ['docs-only', 'repo', 'tags docs', false],
      ['tiny', 'repo', 'type User Story · tags tiny', false],
      ['quick-fix', 'yours', 'type bug', true],
      ['spike', 'yours', '', false],
      ['factory', 'built-in', 'default', false],
    ]);
    expect([choices.picked, choices.why]).toEqual([
      'quick-fix',
      'Preselected: Quick fix takes type bug.',
    ]);
    expect(launchChoices({ type: 'Task', tags: [] }, loaded)).toMatchObject({
      picked: 'factory',
      why: 'Preselected: Factory, for any card no other workflow takes.',
    });
  });

  test.each<[string, string, string | null]>([
    ['one that takes the card', 'quick-fix', null],
    ['the default one', 'factory', null],
    [
      'one whose on: the card misses',
      'tiny',
      'Quick fix takes type User Story · tags tiny; this is a Bug tagged cart. It still runs it.',
    ],
  ])('picked at launch: %s', (_, id, warning) => {
    const card = { type: 'Bug', tags: ['cart'] };
    const o = launchChoices(card, load(bug, tagged, factory)).options.find((x) => x.id === id);

    expect(o === undefined ? 'none' : mismatchWords(card, o)).toBe(warning);
  });

  test.each<[string, string, string]>([
    ['an id no source has', 'nope', 'unknown-workflow'],
    ['one failing the load check', 'broken', 'workflow-problems'],
    ['one with no on: runs all the same', 'investigate', 'ok'],
  ])('--workflow: %s', (_, id, code) => {
    const broken = src(W({ on: 'bug', steps: ['repro', 'implement'] }), { id: 'broken' });
    const picked = pickedWorkflow(id, load(bug, broken, src(W(), { id: 'investigate' })));

    expect(picked.ok ? 'ok' : picked.error.code).toBe(code);
  });

  test('--workflow refused with its problems; an ok one as a run carries it', () => {
    const broken = src(W({ on: 'bug', steps: ['repro', 'implement'] }), { id: 'broken' });
    const loaded = load(bug, broken);
    const refusedOne = pickedWorkflow('broken', loaded);

    expect(refusedOne.ok ? '' : refusedOne.error.message).toBe(
      'broken does not load (1 problem): /c/workflows/broken.yaml: No skill named repro in any Layer',
    );
    expect(pickedWorkflow('quick-fix', loaded)).toMatchObject({
      ok: true,
      data: { id: 'quick-fix', layer: 'yours', name: 'Quick fix' },
    });
  });

  test.each<[string, WorkflowSource[], string]>([
    [
      'yours on: default beats Abe’s Bug',
      [
        src(W({ on: 'default' }), { id: 'mine' }),
        src(W({ name: 'Bug', on: 'Bug' }), { id: 'bug', layer: 'built-in' }),
      ],
      'mine',
    ],
    [
      'the repo’s typed beats yours on: default',
      [
        src(W({ on: 'default' }), { id: 'mine' }),
        src(W({ on: 'Bug' }), { id: 'repo-bug', layer: 'repo' }),
        src(W({ name: 'Bug', on: 'Bug' }), { id: 'bug', layer: 'built-in' }),
      ],
      'repo-bug',
    ],
    [
      'none of yours or the repo’s takes it: Abe’s Bug over Abe’s default',
      [
        src(W({ on: { tags: ['docs'] } }), { id: 'docs', layer: 'repo' }),
        src(W({ name: 'Bug', on: 'Bug' }), { id: 'bug', layer: 'built-in' }),
        src(W({ name: 'Feature', on: 'default' }), { id: 'feature', layer: 'built-in' }),
      ],
      'bug',
    ],
  ])('on: precedence, a Bug card: %s', (_, sources, id) => {
    expect(workflowFor({ type: 'Bug', tags: [] }, load(...sources)).id).toBe(id);
  });

  test('none in force: the built-in Feature', () => {
    expect(
      workflowFor({ type: 'Bug', tags: [] }, load(src(W({ on: 'bug', steps: ['repro'] })))),
    ).toEqual(FEATURE_WORKFLOW);
  });
});

describe('check: expressions over facts', () => {
  test.each<[string, Record<string, number | boolean | string>, boolean]>([
    ['checks.failed > 0', { 'checks.failed': 2 }, true],
    ['checks.failed > 0', {}, false],
    ['a.b == 1 and not c', { 'a.b': 1, c: 0 }, true],
    ['a > 1 or b', { a: 0, b: true }, true],
    ['not (a >= 2 and b <= 1)', { a: 2, b: 1 }, false],
    ['a != 3', { a: 3 }, false],
    ['done', { done: false }, false],
  ])('%s over %j is %p', (text, facts, holds) => {
    expect(checkHolds(text, facts)).toBe(holds);
  });

  test.each(['', 'a >', 'a b', '(a > 1', 'and a', '> 1', 'a $ 1'])('%p does not read', (text) => {
    expect(parseCheck(text).ok).toBe(false);
  });
});
