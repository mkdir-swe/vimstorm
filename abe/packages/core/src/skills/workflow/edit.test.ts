import { describe, expect, test } from 'bun:test';
import { fixesOf, type ReadHeader, readableSkill, readableWorkflow } from './edit';
import { loadWorkflows, type WorkflowProblemCode, type WorkflowsData } from './load';

const KNOWN = ['reproduce', 'implement', 'code-review', 'verify', 'pr', 'release-notes'];
const file = (...lines: string[]) => `${lines.join('\n')}\n`;
const UI_BUG = [
  'name: UI bug',
  'steps:',
  '  - reproduce',
  '  - verify',
  '  - code-review:',
  '      reviewers: [kim]',
  '  - implement',
  '  - pr',
];

describe('⌥⏎: each problem’s fixes, the whole file after each', () => {
  test.each<[string, string, WorkflowProblemCode, number, [string, string][]]>([
    [
      'a skill no Layer has: the nearest names, or the step gone',
      file('steps:', '  - reprodce', '  - implement'),
      'unknown-skill',
      2,
      [
        ['Replace with reproduce', file('steps:', '  - reproduce', '  - implement')],
        ['Remove step reprodce', file('steps:', '  - implement')],
      ],
    ],
    [
      'one with options goes with them',
      file('steps:', '  - nope:', '      pin: repo', '  - implement'),
      'unknown-skill',
      2,
      [['Remove step nope', file('steps:', '  - implement')]],
    ],
    [
      'verify before its build: moved after it, its options with it',
      file(...UI_BUG),
      'needs-build',
      4,
      [
        [
          'Move verify after implement',
          file(...UI_BUG.slice(0, 3), ...UI_BUG.slice(4, 7), '  - verify', '  - pr'),
        ],
      ],
    ],
    [
      'a review before its build, with its options',
      file(...UI_BUG),
      'needs-build',
      5,
      [
        [
          'Move code-review after implement',
          file(...UI_BUG.slice(0, 4), '  - implement', ...UI_BUG.slice(4, 6), '  - pr'),
        ],
      ],
    ],
    [
      'pr not last',
      file('steps:', '  - implement', '  - pr', '  - reproduce'),
      'pr-last',
      3,
      [['Move pr to the end', file('steps:', '  - implement', '  - reproduce', '  - pr')]],
    ],
    [
      'a step twice',
      file('steps:', '  - implement', '  - implement'),
      'duplicate-step',
      3,
      [['Remove this implement', file('steps:', '  - implement')]],
    ],
    [
      'both kinds in a flow when: the judge and its sees: dropped',
      file('loops:', '  - when: { check: pr.comments.open > 0, judge: Asks for code?, sees: [x] }'),
      'both-kinds',
      2,
      [['Keep check:, drop judge:', file('loops:', '  - when: { check: pr.comments.open > 0 }')]],
    ],
    [
      'both kinds in a block when:',
      file(
        'loops:',
        '  - from: pr',
        '    when:',
        '      check: pr.comments.open > 0',
        '      judge: Does a comment ask for code?',
        '      sees: [pr.comments]',
        '    max: 2',
      ),
      'both-kinds',
      5,
      [
        [
          'Keep check:, drop judge:',
          file(
            'loops:',
            '  - from: pr',
            '    when:',
            '      check: pr.comments.open > 0',
            '    max: 2',
          ),
        ],
      ],
    ],
    [
      'a loop with no max: added under it',
      file('loops:', '  - from: verify', '    to: implement', '    carries: [x]', 'other: 1'),
      'no-max',
      2,
      [
        [
          'Add max: 2',
          file(
            'loops:',
            '  - from: verify',
            '    to: implement',
            '    carries: [x]',
            '    max: 2',
            'other: 1',
          ),
        ],
      ],
    ],
    [
      'a sequence entry out of line: lined up under the one above',
      file('steps:', '  - reproduce', '   - implement'),
      'not-yaml',
      3,
      [['Fix indentation', file('steps:', '  - reproduce', '  - implement')]],
    ],
    ['a problem with no plain fix', file('steps:', '  - x'), 'loop-step', 2, []],
  ])('%s', (_, text, code, line, want) => {
    expect(
      fixesOf(text, { code, line, text: '' }, { known: KNOWN }).map((f) => [f.title, f.text]),
    ).toEqual(want);
  });
});

const data = (): WorkflowsData => ({
  ...loadWorkflows({
    sources: [
      {
        layer: 'repo',
        file: '/shop/.abe/workflows/hotfix.yaml',
        id: 'hotfix',
        read: {
          doc: {
            name: 'Hotfix',
            description: 'A small bug, straight to a pull request.',
            on: { type: 'Bug', tags: ['prod'] },
            branch: 'hotfix/<card>',
            steps: ['implement', { verify: { pin: 'repo' } }, 'pr'],
            loops: [
              {
                from: 'verify',
                to: 'implement',
                when: { check: 'criteria.failed > 0' },
                carries: ['evidence'],
                max: 2,
              },
            ],
          },
        },
      },
    ],
    skills: [
      { name: 'implement', layer: 'built-in', description: 'Test-first on the card branch.' },
      { name: 'unslop', layer: 'repo', description: 'Plain, short text.' },
    ],
  }),
  layers: [
    { layer: 'yours', name: null, dir: '/mine' },
    { layer: 'repo', name: 'demo-shop', dir: '/shop/.abe' },
    { layer: 'built-in', name: null, dir: null },
  ],
});

describe('the readable side: whose it is, then the file in words', () => {
  const header = (h: Partial<ReadHeader>): ReadHeader => ({
    layer: 'repo',
    readOnly: true,
    mine: null,
    proposeTo: null,
    ...h,
  });

  test.each<[string, Partial<ReadHeader>, string[]]>([
    [
      "the repo's: the team's file, changed in place",
      { readOnly: false },
      [
        "*from repo demo-shop* · The team's file: commit it like the code.",
        '[Change with AI ⌘G](abe:change) · [Retro…](abe:retro)',
      ],
    ],
    [
      "the repo's you have a copy of: Open my copy",
      { readOnly: false, mine: '/mine/workflows/hotfix.yaml', compare: 'yours' },
      [
        "*from repo demo-shop* · The team's file. Your copy wins for you.",
        '[Change with AI ⌘G](abe:change) · [Open my copy](abe:mine) · [Compare with mine ⌘D](abe:compare) · [Retro…](abe:retro)',
      ],
    ],
    [
      'your copy over the repo’s: Propose',
      { layer: 'yours', readOnly: false, proposeTo: 'repo', compare: 'repo' },
      [
        "*your copy* · of repo demo-shop's Hotfix. It runs for you only.",
        '[Change with AI ⌘G](abe:change) · [Compare with repo demo-shop ⌘D](abe:compare) · [Propose to repo demo-shop…](abe:propose) · [Retro…](abe:retro)',
      ],
    ],
    [
      'your own',
      { layer: 'yours', readOnly: false },
      [
        '*yours* · Yours to change: it runs as you save it.',
        '[Change with AI ⌘G](abe:change) · [Retro…](abe:retro)',
      ],
    ],
  ])('%s', (_, h, want) => {
    const d = data();
    const w = d.workflows[0];

    if (w === undefined) throw new Error('no workflow');
    const lines = readableWorkflow(w, d, header(h)).split('\n');

    expect([lines[2], lines[4]]).toEqual(want);
  });

  test('a workflow in words: steps, what runs it, its branch and loops; a retro under it', () => {
    const d = data();
    const w = d.workflows[0];

    if (w === undefined) throw new Error('no workflow');
    const text = readableWorkflow(w, d, header({}), {
      runs: [
        { card: 1272, outcome: 'stopped at verify' },
        { card: 1255, outcome: 'merged' },
      ],
      findings: [
        {
          severity: 'high',
          title: 'Steps',
          what: 'Both failed runs broke at verify on a type error.',
          moments: ['#1272 verify'],
          fix: { summary: 'a review before verify' },
        },
      ],
    });

    expect(text.split('\n').slice(6)).toEqual([
      'A small bug, straight to a pull request.',
      '',
      '## Steps',
      '',
      '1. **implement**: Test-first on the card branch.',
      '2. **verify** · pinned by repo: runs verify',
      '3. **pr**: runs pr',
      '',
      '## Runs on',
      '',
      'a Bug card tagged prod',
      '',
      '## Branch',
      '',
      '`hotfix/<card>`',
      '',
      '## Loops',
      '',
      '1. **verify → implement** when `criteria.failed > 0`, carries evidence; up to 2, then ◆ Needs you',
      '',
      '## Retro · 2 runs read',
      '',
      '#1272 stopped at verify · #1255 merged',
      '',
      '### Findings, most severe first',
      '',
      '1. **high** · Steps: Both failed runs broke at verify on a type error. · #1272 verify · [Fix it in the file: a review before verify](abe:fix/1)',
      '',
    ]);
  });

  test('a skill: whose it is over its text, frontmatter off; the workflows using it', () => {
    const d = data();
    const s = d.skills.find((k) => k.name === 'implement');

    if (s === undefined) throw new Error('no skill');
    const text = readableSkill(
      s,
      d,
      header({ layer: 'built-in' }),
      '---\nname: implement\n---\n# Implement\n\nTest first.\n',
    );

    expect(text.split('\n')).toEqual([
      '*from built-in* · Read-only here. An edit makes your copy.',
      '',
      '[Edit my copy](abe:copy) · [Retro…](abe:retro)',
      '',
      '# Implement',
      '',
      'Test first.',
      '',
      '## Used by',
      '',
      'Hotfix',
      '',
    ]);
  });
});
