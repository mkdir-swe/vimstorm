/** Rule tables for Improve retro: scopes to prefixes, moment resolution, the removal rule, the answer. */
import { describe, expect, test } from 'bun:test';
import {
  type EarlierPull,
  type EarlierVerdict,
  type Finding,
  fixPathProblem,
  inPrefixes,
  judgeEarlier,
  layerRepoPath,
  lineDigest,
  momentLine,
  momentWords,
  movedSince,
  proposesRemoval,
  readRetro,
  resolveMoment,
  RETRO_SKILL,
  retroBranch,
  retroPrBody,
  retroPrefixes,
  retroPrompt,
  type RetroData,
  type RetroScope,
  type RetroSource,
  scopeTimeAfter,
  sessionsToRead,
} from './retro';

const WHO = { repo: 'o/shop', login: 'octocat' };

describe('a scope reads only its prefixes', () => {
  test.each<[RetroScope, string[]]>([['me', ['o_shop/octocat/']]])('%s', (scope, prefixes) => {
    expect(retroPrefixes(scope, WHO)).toEqual(prefixes);
  });

  test.each<[RetroScope, string, boolean]>([
    ['me', 'o_shop/octocat/4-a1b2/meta.json', true],
    ['me', 'o_shop/sam/5-c3d4/meta.json', false],
    ['me', 'o_api/octocat/6-e5f6/meta.json', false],
    // `octo` is not `octocat`: the prefix ends at the slash.
    ['me', 'o_shop/octocat2/7-a1b2/meta.json', false],
    ['me', 'o_shopx/octocat/5-c3d4/meta.json', false],
  ])('%s reads %s: %p', (scope, key, read) => {
    expect(inPrefixes(key, retroPrefixes(scope, WHO))).toBe(read);
  });

  test('a key part is made safe as the log store made it', () => {
    expect(retroPrefixes('me', { repo: 'o/my shop', login: 'o/c' })).toEqual(['o_my_shop/o_c/']);
  });

  test.each<[string, string | null, boolean]>([
    ['2026-10-20T10:00:00.000Z', null, true],
    ['2026-10-20T10:00:00.000Z', '2026-10-19T00:00:00.000Z', true],
    ['2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z', false],
    ['2026-10-18T10:00:00.000Z', '2026-10-19T00:00:00.000Z', false],
  ])('a session last moved %s counts after a retro at %s: %p', (since, last, counts) => {
    expect(movedSince({ card: 4, title: '', since }, last)).toBe(counts);
  });
});

const SOURCES: RetroSource[] = [
  {
    session: '4-a1b2',
    name: 'checks.md',
    text: '# Checks\n\n- types: red\n  src/cart.ts(3): error\n',
  },
  { session: '4-a1b2', name: 'review/1.md', text: 'one line, no newline' },
  { session: 'layers', name: 'overrides.md', text: '- repo autoMerge = true: no checks yet\n' },
];

describe('moment resolution', () => {
  test.each<[string, string | null]>([
    ['4-a1b2/checks.md#3', '- types: red'],
    ['4-a1b2/checks.md#4', 'src/cart.ts(3): error'],
    ['4-a1b2/review/1.md#1', 'one line, no newline'],
    ['layers/overrides.md#1', '- repo autoMerge = true: no checks yet'],
    // Past the end: the trailing newline ends the last line, it starts none.
    ['4-a1b2/checks.md#5', null],
    ['4-a1b2/checks.md#0', null],
    ['4-a1b2/hooks.jsonl#1', null],
    ['9-zzzz/checks.md#1', null],
    ['4-a1b2/checks.md', null],
    ['checks.md#1', null],
    ['../etc/passwd#1', null],
  ])('%s', (ref, text) => {
    const r = resolveMoment(ref, SOURCES);

    expect(r.ok ? r.moment.text : null).toBe(text);
  });

  test('a resolved moment names its session, file and line', () => {
    expect(resolveMoment(' 4-a1b2/checks.md#3 ', SOURCES)).toEqual({
      ok: true,
      moment: {
        ref: '4-a1b2/checks.md#3',
        session: '4-a1b2',
        file: 'checks.md',
        line: 3,
        text: '- types: red',
      },
    });
  });
});

const PULL: EarlierPull = {
  pr: 'o/shop#12',
  url: 'https://github.com/o/shop/pull/12',
  title: 'Run types in Build (improve retro 2026-10-01, finding 1)',
  mergedAt: '2026-10-02T09:00:00Z',
};

const finding = (o: Partial<Finding> = {}): Finding => ({
  n: 1,
  severity: 'high',
  title: 'Type errors reach Review',
  whatHappened: 'Checks failed in Review on types.',
  moments: [
    {
      ref: '4-a1b2/checks.md#3',
      session: '4-a1b2',
      file: 'checks.md',
      line: 3,
      text: '- types: red',
    },
  ],
  layer: 'repo',
  fix: {
    summary: 'types in Build',
    files: [{ path: 'settings.yaml', content: 'x\n' }],
    diff: '',
    issue: null,
  },
  recurringOf: null,
  removes: null,
  made: null,
  ...o,
});

describe('the removal rule', () => {
  test.each<[EarlierVerdict, boolean]>([
    ['helping', false],
    ['recurring', true],
    ['noisy', true],
    ['unclear', false],
  ])('%s: proposed for removal %p', (verdict, removal) => {
    expect(proposesRemoval(verdict)).toBe(removal);
  });

  type Said = { verdict: 'helping' | 'recurring' | 'noisy'; moments: string[] } | undefined;
  test.each<[string, Said, Finding[], EarlierVerdict, boolean, boolean]>([
    ['said helping', { verdict: 'helping', moments: [] }, [], 'helping', false, false],
    [
      'said noisy, shown',
      { verdict: 'noisy', moments: ['4-a1b2/checks.md#3'] },
      [],
      'noisy',
      true,
      false,
    ],
    ['said noisy, not shown', { verdict: 'noisy', moments: [] }, [], 'unclear', false, true],
    [
      'said recurring, moment off the end',
      { verdict: 'recurring', moments: ['4-a1b2/checks.md#99'] },
      [],
      'unclear',
      false,
      true,
    ],
    ['not judged', undefined, [], 'unclear', false, false],
    // A finding recurring of it makes it recurring, whatever was said.
    [
      'said helping, but a finding recurs of it',
      { verdict: 'helping', moments: [] },
      [finding({ recurringOf: 'o/shop#12' })],
      'recurring',
      true,
      false,
    ],
    [
      'not judged, a finding recurs of it',
      undefined,
      [finding({ recurringOf: 'O/Shop#12' })],
      'recurring',
      true,
      false,
    ],
    [
      'a finding recurring of another fix',
      undefined,
      [finding({ recurringOf: 'o/shop#13' })],
      'unclear',
      false,
      false,
    ],
  ])('%s', (_, said, findings, verdict, removal, dropped) => {
    const judged = judgeEarlier(
      PULL,
      said === undefined ? undefined : { pr: PULL.pr, why: 'because', ...said },
      findings,
      SOURCES,
    );

    expect(judged.fix.verdict).toBe(verdict);
    expect(judged.fix.removal).toBe(removal);
    expect(judged.dropped !== undefined).toBe(dropped);
  });
});

describe('fix paths stay in their Layer', () => {
  test.each<[string, boolean]>([
    ['scripts/seed-demo.sh', true],
    ['settings.yaml', true],
    ['skills/build/SKILL.md', true],
    ['/etc/passwd', false],
    ['../src/cart.ts', false],
    ['scripts/../../x', false],
    ['a//b', false],
    ['a\\b', false],
    ['', false],
  ])('%s: %p', (path, ok) => {
    expect(fixPathProblem(path) === undefined).toBe(ok);
  });

  test("the repo Layer writes the team's files: abe.yaml, .claude/skills, run-app's scripts", () => {
    expect(
      ['settings.yaml', 'skills/verify-shop/SKILL.md', 'scripts/seed.sh', 'playbooks/x.md'].map(
        (p) => layerRepoPath(p),
      ),
    ).toEqual([
      'abe.yaml',
      '.claude/skills/verify-shop/SKILL.md',
      '.claude/skills/run-app/scripts/seed.sh',
      '.abe/playbooks/x.md',
    ]);
  });
});

const answer = (findings: unknown[], earlier: unknown[] = []) =>
  JSON.stringify({ findings, earlier });
const said = (o: Record<string, unknown>) => ({
  severity: 'medium',
  title: 'A finding',
  whatHappened: 'It happened.',
  moments: ['4-a1b2/checks.md#3'],
  layer: 'repo',
  fix: {
    summary: 'the fix',
    files: [{ path: 'settings.yaml', content: 'checks: [types]\n' }],
    diff: '+types',
  },
  recurringOf: null,
  removes: null,
  ...o,
});

describe('reading the answer', () => {
  test('most severe first, numbered; a finding whose moment does not resolve is dropped and counted', () => {
    const read = readRetro(
      answer([
        said({ title: 'low one', severity: 'low' }),
        said({ title: 'off the end', severity: 'critical', moments: ['4-a1b2/checks.md#40'] }),
        said({ title: 'high one', severity: 'high' }),
        said({ title: 'no moment', moments: [] }),
        said({
          title: 'out of its Layer',
          fix: { summary: 's', files: [{ path: '../x', content: '' }] },
        }),
        said({ title: 'recurs of nothing', recurringOf: 'o/shop#99' }),
        said({ title: 'second high', severity: 'high', layer: 'individual' }),
        said({ title: 'no file', fix: { summary: 's', files: [] } }),
        said({
          title: 'send to Abe',
          severity: 'low',
          layer: 'abe',
          fix: { summary: 's', issue: { title: 'A longer push timeout', body: 'Hooks are slow.' } },
        }),
        said({ title: 'send to Abe, no issue', layer: 'abe', fix: { summary: 's' } }),
      ]),
      { sources: SOURCES, earlier: [] },
    );

    if (!read.ok) throw new Error(read.message);
    expect(read.findings.map((f) => [f.n, f.severity, f.title])).toEqual([
      [1, 'high', 'high one'],
      [2, 'high', 'second high'],
      [3, 'low', 'low one'],
      [4, 'low', 'send to Abe'],
    ]);
    expect(read.findings.at(-1)?.fix).toEqual({
      summary: 's',
      files: [],
      diff: '',
      issue: { title: 'A longer push timeout', body: 'Hooks are slow.' },
    });
    expect(read.dropped.map((d) => d.title)).toEqual([
      'off the end',
      'no moment',
      'out of its Layer',
      'recurs of nothing',
      'no file',
      'send to Abe, no issue',
    ]);
    expect(read.dropped[0]?.why).toBe('4-a1b2/checks.md#40: checks.md has 4 lines');
  });

  test('a recurring fix is judged recurring and proposed for removal, by the finding that removes it', () => {
    const read = readRetro(
      answer(
        [
          said({ title: 'types again', severity: 'high', recurringOf: 'o/shop#12' }),
          said({
            title: 'take out the old check',
            layer: 'repo',
            removes: 'o/shop#12',
            fix: { summary: 'drop it', files: [{ path: 'scripts/old-check.sh', content: null }] },
          }),
        ],
        [{ pr: 'o/shop#12', verdict: 'helping', why: 'fine' }],
      ),
      { sources: SOURCES, earlier: [PULL] },
    );

    if (!read.ok) throw new Error(read.message);
    expect(read.findings.map((f) => [f.n, f.recurringOf, f.removes])).toEqual([
      [1, 'o/shop#12', null],
      [2, null, 'o/shop#12'],
    ]);
    expect(read.earlier[0]).toMatchObject({
      pr: 'o/shop#12',
      verdict: 'recurring',
      removal: true,
      removedBy: 2,
    });
  });

  test.each([
    ['no JSON', 'I found nothing worth saying.'],
    ['no findings key', '{"earlier": []}'],
    ['an unknown Layer', answer([said({ layer: 'core' })])],
  ])('%s is unreadable', (_, text) => {
    expect(readRetro(text, { sources: SOURCES, earlier: [] }).ok).toBe(false);
  });
});

describe('the prompt', () => {
  const session = (id: string, since: string, size = 50) => ({
    session: id,
    repo: 'o_shop',
    user: 'octocat',
    card: 4,
    title: 'Sign in',
    since,
    files: [{ name: 'checks.md', text: `${'x'.repeat(50)}\n`.repeat(size / 50) }],
  });

  test('numbered lines, the earlier fixes, the Layer files, the skill as its system prompt', () => {
    const prompt = retroPrompt({
      scope: 'me',
      who: WHO,
      sessions: [session('4-a1b2', '2026-10-20T10:00:00.000Z')],
      extra: [{ session: 'layers', name: 'overrides.md', text: '- repo autoMerge = true\n' }],
      earlier: [PULL],
      layers: [
        {
          layer: 'repo',
          repo: 'o/shop',
          files: [{ path: 'settings.yaml', text: 'checks: [tests]\n' }],
        },
      ],
    });

    expect(prompt).toContain(`### 4-a1b2/checks.md (1 lines)\n\n    1  ${'x'.repeat(50)}`);
    expect(prompt).toContain('### layers/overrides.md (1 lines)\n\n    1  - repo autoMerge = true');
    expect(prompt).toContain('- o/shop#12 merged 2026-10-02T09:00:00Z');
    expect(prompt).toContain('### settings.yaml\n\n```\nchecks: [tests]\n```');
    expect(prompt).toContain('scope me: octocat in o/shop');
    expect(RETRO_SKILL).toContain('# Retro');
    expect(RETRO_SKILL).not.toContain('upstream:');
  });

  test('a long file keeps its first and last lines, numbered as stored', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    const prompt = retroPrompt({
      scope: 'me',
      who: WHO,
      sessions: [
        { ...session('4-a1b2', '2026-10-20T10:00:00.000Z'), files: [{ name: 'checks.md', text }] },
      ],
      extra: [],
      earlier: [],
      layers: [],
    });

    expect(prompt).toContain('   80  line 80\n       … lines 81–340 left out\n  341  line 341');
    expect(prompt).toContain('  500  line 500');
  });

  test('a JSON line shows its words, ids left out', () => {
    expect(
      lineDigest(
        'transcript.jsonl',
        JSON.stringify({
          uuid: 'u-1',
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Running   tsc' }] },
        }),
      ),
    ).toBe('assistant · assistant · text · Running tsc');
    expect(lineDigest('checks.md', 'x'.repeat(400))).toHaveLength(301);
  });

  test('a moment reads as a line: its time, its ref, what it says quoted', () => {
    const said = momentWords(
      'transcript.jsonl',
      JSON.stringify({
        uuid: 'u-1',
        timestamp: '2026-10-29T02:37:56.120Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Recording   verify.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'abe factory verify' } },
          ],
        },
      }),
    );

    expect(momentLine({ ref: '4-a1b2/transcript.jsonl#7', ...said })).toBe(
      '02:37:56  4-a1b2/transcript.jsonl#7  "assistant: Recording verify. · Bash: abe factory verify"',
    );
    expect(momentWords('checks.md', '- types: red')).toEqual({ text: '- types: red' });
  });

  test("a JSON file's line reads as its key and words, never a quote escaped", () => {
    expect(momentWords('run.json', '    "doneWhen": "An existing id says \\"found\\"",')).toEqual({
      text: 'doneWhen: An existing id says "found"',
    });
    expect(momentWords('run.json', '  "attempts": 2,')).toEqual({ text: 'attempts: 2' });
    expect(momentWords('run.json', '  "steps": [')).toEqual({ text: 'steps:' });
    expect(momentWords('run.json', '    "verify",')).toEqual({ text: 'verify' });
    expect(momentWords('run.json', '  },')).toEqual({ text: '}' });
  });

  test("a JSON file's opening key reads with the first value under it", () => {
    expect(
      momentWords('run.json', '  "summary": {', ['    "checks": [', '      "types: red",']),
    ).toEqual({ text: 'summary: types: red' });
    expect(momentWords('run.json', '  "summary": {', ['    "text": "The run stopped"'])).toEqual({
      text: 'summary: text: The run stopped',
    });
    expect(momentWords('run.json', '  "steps": [', ['  ],', '  "attempts": 2'])).toEqual({
      text: 'steps:',
    });
    expect(momentWords('run.json', '  "notes": {},', ['  "attempts": 2'])).toEqual({
      text: 'notes:',
    });
  });

  test('the oldest sessions are read first; past the budget the newer are left out for next time', () => {
    const { read, leftOut } = sessionsToRead(
      [
        session('old', '2026-10-01T00:00:00.000Z', 600),
        session('new', '2026-10-20T00:00:00.000Z', 600),
        session('mid', '2026-10-10T00:00:00.000Z', 600),
      ],
      2000,
    );

    expect(read.map((s) => s.session)).toEqual(['old', 'mid']);
    expect(leftOut.map((s) => s.session)).toEqual(['new']);
    // The next retro reads after the newest read one: the left-out session comes then.
    expect(scopeTimeAfter(read, leftOut, '2026-10-23T00:00:00.000Z')).toBe(
      '2026-10-10T00:00:00.000Z',
    );
    expect(scopeTimeAfter(read, [], '2026-10-23T00:00:00.000Z')).toBe('2026-10-23T00:00:00.000Z');
  });
});

describe('the pull request', () => {
  const retro: RetroData = {
    id: 'retro-20261023-1a2b',
    at: '2026-10-23T09:00:00.000Z',
    scope: 'me',
    repo: 'o/shop',
    login: 'octocat',
    since: null,
    prefixes: ['o_shop/octocat/'],
    sessions: [
      {
        session: '4-a1b2',
        repo: 'o_shop',
        user: 'octocat',
        card: 4,
        title: 'Sign in',
        since: '2026-10-20T10:00:00.000Z',
        files: 3,
      },
      {
        session: '5-c3d4',
        repo: 'o_shop',
        user: 'sam',
        card: 5,
        title: 'Cart',
        since: '2026-10-21T10:00:00.000Z',
        files: 2,
      },
    ],
    leftOut: 0,
    unread: [],
    model: 'opus',
    findings: [finding()],
    earlier: [],
    dropped: [],
  };

  test('names the retro and its sessions, and each moment', () => {
    const body = retroPrBody(retro, finding({ recurringOf: 'o/shop#12' }));

    expect(body).toContain(
      'Improve retro retro-20261023-1a2b (me (octocat in o/shop), 2026-10-23), finding 1 of 1, high.',
    );
    expect(body).toContain('Sessions: 4-a1b2, 5-c3d4');
    expect(body).toContain('- `4-a1b2/checks.md#3`: - types: red');
    expect(body).toContain('Recurring of o/shop#12.');
    expect(retroBranch(retro.id, 1)).toBe('abe/retro-20261023-1a2b-1');
  });
});
