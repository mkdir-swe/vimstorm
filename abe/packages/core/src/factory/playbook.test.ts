/** A run's Playbook: its shape, and a step against an environment agents may not reach the person's. */
import { describe, expect, test } from 'bun:test';
import { keptPlaybook, parsePlaybook, playbookProblems } from './playbook';

const step = (n: number, o: { who?: string; where?: string; runnable?: string; cmd?: string }) =>
  [
    `## ${n}. Step ${n}`,
    '',
    ...(o.who === undefined ? [] : [`Who: ${o.who}`]),
    ...(o.where === undefined ? [] : [`Where: ${o.where}`]),
    ...(o.runnable === undefined ? [] : [`Runnable: ${o.runnable}`]),
    '',
    'What to do.',
    '',
    ...(o.cmd === undefined ? [] : ['```sh', o.cmd, '```', '']),
    'Check: it worked',
    'Undo: one-way',
    '',
  ].join('\n');

const playbook = (...steps: string[]) =>
  ['# Saved carts: playbook', '', 'Done when: a saved cart survives sign-out', '', ...steps].join(
    '\n',
  );

const MIGRATE = step(1, { who: 'Abe', where: 'test', runnable: 'yes', cmd: 'npm run migrate' });
const FLAG = step(2, { who: 'you', where: 'the flag dashboard', runnable: 'no' });
const DEPLOY = step(3, { who: 'you', where: 'prod', runnable: 'yes', cmd: 'npm run deploy:prod' });

describe('a Playbook read from its Markdown', () => {
  test('title, Done when, and each step with its Who, Where, Runnable, command and Check', () => {
    const pb = parsePlaybook(playbook(MIGRATE, FLAG));

    expect(pb.title).toBe('Saved carts');
    expect(pb.doneWhen).toBe('a saved cart survives sign-out');
    expect(pb.steps).toEqual([
      {
        n: 1,
        title: 'Step 1',
        who: 'abe',
        where: 'test',
        runnable: true,
        command: 'npm run migrate',
        check: 'it worked',
        undo: 'one-way',
      },
      {
        n: 2,
        title: 'Step 2',
        who: 'you',
        where: 'the flag dashboard',
        runnable: false,
        command: null,
        check: 'it worked',
        undo: 'one-way',
      },
    ]);
  });

  test('a heading inside a code block is no step', () => {
    const pb = parsePlaybook(
      playbook(step(1, { who: 'you', where: 'dev', runnable: 'yes', cmd: '## 2. not a step' })),
    );

    expect(pb.steps.map((s) => s.n)).toEqual([1]);
  });
});

describe('what a Playbook must say, one problem a row', () => {
  test.each<[string, string, string[]]>([
    ['a good one', playbook(MIGRATE, FLAG, DEPLOY), []],
    ['no title', playbook(MIGRATE).replace('# Saved carts: playbook', ''), ['no title']],
    ['no Done when', playbook(MIGRATE).replace(/^Done when:.*$/m, ''), ['no `Done when:` line']],
    ['no steps', playbook(), ['no steps']],
    ['out of order', playbook(step(2, { who: 'you', where: 'dev', runnable: 'no' })), ['step 2']],
    ['no Who', playbook(step(1, { where: 'dev', runnable: 'no' })), ['step 1 has no `Who']],
    ['no Where', playbook(step(1, { who: 'you', runnable: 'no' })), ['step 1 has no `Where']],
    ['no Runnable', playbook(step(1, { who: 'you', where: 'dev' })), ['step 1 has no `Runnable']],
    [
      'runnable with nothing to run',
      playbook(step(1, { who: 'Abe', where: 'dev', runnable: 'yes' })),
      ['step 1 is Runnable: yes with no command block'],
    ],
    [
      "a prod step handed to Abe: it is the person's",
      playbook(step(1, { who: 'Abe', where: 'prod', runnable: 'yes', cmd: 'npm run deploy' })),
      ["step 1 is the person's (prod is not enabled for agents in this repo)"],
    ],
    [
      "production is prod's too",
      playbook(step(1, { who: 'Abe', where: 'Production', runnable: 'no' })),
      ["step 1 is the person's (prod is not enabled"],
    ],
  ])('%s', (_, text, want) => {
    const problems = playbookProblems(parsePlaybook(text));

    expect(problems.length).toBe(want.length);
    want.forEach((w, i) => {
      expect(problems[i]).toStartWith(w);
    });
  });
});

describe("a step against an environment not enabled for agents is the person's", () => {
  test.each<[string, string, readonly string[] | undefined, 'you' | 'abe', string | null]>([
    ['test, enabled by default', MIGRATE, undefined, 'abe', null],
    [
      'prod, not enabled by default',
      step(1, { who: 'you', where: 'prod', runnable: 'no' }),
      undefined,
      'you',
      'prod is not enabled for agents in this repo',
    ],
    [
      'test, this repo enabled dev only',
      MIGRATE,
      ['dev'],
      'you',
      'test is not enabled for agents in this repo',
    ],
    [
      'prod, this repo turned it on',
      step(1, { who: 'Abe', where: 'prod', runnable: 'no' }),
      ['dev', 'test', 'prod'],
      'abe',
      null,
    ],
    ["a system's name goes by its Who", FLAG.replace('## 2.', '## 1.'), undefined, 'you', null],
  ])('%s', (_, text, enabled, by, theirs) => {
    const kept = keptPlaybook(7, parsePlaybook(playbook(text)), enabled);

    expect(kept.path).toBe('.abe/playbooks/7.md');
    expect(kept.steps.map((s) => [s.by, s.theirs])).toEqual([[by, theirs]]);
  });

  test('a step handed to Abe on an environment this repo enabled holds; off, it is refused', () => {
    const pb = parsePlaybook(playbook(MIGRATE));

    expect(playbookProblems(pb, ['dev', 'test'])).toEqual([]);
    expect(playbookProblems(pb, ['dev'])).toEqual([
      "step 1 is the person's (test is not enabled for agents in this repo): `Who: you`. Abe never runs a step there",
    ]);
  });
});
