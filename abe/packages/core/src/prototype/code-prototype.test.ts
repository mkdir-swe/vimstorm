/**
 * A prototype session: the branch and its worktree's place, its words, the run of a card's that
 * sits in Build and never ships, the session's kind, and make-card's upload.
 */
import { describe, expect, test } from 'bun:test';
import {
  codePrototypeInstructions,
  codePrototypePrompt,
  codeCardComment,
  type CodeShown,
  codeStoreVersion,
  codeUploadPlan,
  diffFiles,
  type Move,
  newRun,
  PRE_PUSH_HOOK,
  prRefusal,
  PROTOTYPE_DESIGN_RULES,
  PROTOTYPE_NEVER_SHIPS,
  PROTOTYPE_TAKES,
  prototypeBranch,
  prototypeReadme,
  referencePrompt,
  RunReference,
  runReference,
  runData,
  withKind,
  step,
  withUploaded,
  worktreePath,
} from '../index';

const T = (s: number) => new Date(Date.UTC(2026, 9, 23, 10, 0, s)).toISOString();

const proto = () =>
  newRun({
    session: '4-ab12',
    card: 4,
    title: 'Show VAT',
    repo: '/r/shop',
    worktree: '/r/shop-wt/proto-4-show-vat',
    at: T(0),
    prototype: true,
  });

describe('the branch and its worktree', () => {
  test.each([
    [4, 'Show VAT under the cart total', 'proto/4-show-vat-under-the-cart'],
    [12, '!!!', 'proto/12'],
    ['proto-1a2b3c', 'try a VAT line', 'proto/1a2b3c-try-a-vat-line'],
  ])('%s %j → %s', (key, title, branch) => {
    expect(prototypeBranch(key, title)).toBe(branch);
  });

  test('beside the checkout, never nested: proto/4-x → <repo>-wt/proto-4-x', () => {
    expect(worktreePath('/p/shop', 'proto/4-show-vat')).toBe('/p/shop-wt/proto-4-show-vat');
    expect(worktreePath('/p/shop', 'card/4-show-vat')).toBe('/p/shop-wt/4-show-vat');
  });

  test('the pre-push hook refuses every push, saying why', () => {
    expect(PRE_PUSH_HOOK).toStartWith('#!/bin/sh\n');
    expect(PRE_PUSH_HOOK).toContain(PROTOTYPE_NEVER_SHIPS);
    expect(PRE_PUSH_HOOK.trimEnd()).toEndWith('exit 1');
  });

  test('the session is launched on the prototype skill with the card, or the words alone', () => {
    const prompt = codePrototypePrompt({
      card: {
        id: 4,
        title: 'Show VAT',
        description: 'Shoppers ask.',
        acceptanceCriteria: '- VAT shows',
      },
      words: '',
    });

    expect(prompt).toStartWith('/abe:prototype Work on card AB#4: Show VAT');
    expect(prompt).toContain('- VAT shows');
    expect(codePrototypePrompt({ card: null, words: ' a VAT line ' })).toBe(
      '/abe:prototype a VAT line',
    );
  });
});

describe("a prototype session's words: where its app runs, a design and the database", () => {
  const words = (o: { fixedPorts?: number[]; onBox?: boolean }) =>
    codePrototypeInstructions({
      id: 'proto-1a2b3c',
      card: null,
      branch: 'proto/1a2b3c-vat',
      base: 'main',
      commit: 'abcdef0123456789abcdef0123456789abcdef01',
      ...o,
    });

  test.each<[string, Parameters<typeof words>[0], string, string | null]>([
    ['behind the proxy', {}, 'behind the prototype proxy', "on the repo's own ports"],
    [
      'on fixed ports: the normal way, no proxy, the main app back after',
      { fixedPorts: [4000] },
      "on the repo's own ports (:4000), with no proxy",
      'behind the prototype proxy',
    ],
    ['on a box: started there', { onBox: true }, 'abe run prototype-start', 'with no proxy'],
  ])('%s', (_, o, has, hasNot) => {
    const text = words(o);

    expect(text).toContain(has);
    if (hasNot !== null) expect(text).not.toContain(hasNot);
    // every kind: a Figma link read with the Figma MCP, the database never migrated
    expect(text).toContain(PROTOTYPE_DESIGN_RULES);
  });

  test("the rules: the Figma MCP and the repo's own components; no migration, a field mocked", () => {
    expect(PROTOTYPE_DESIGN_RULES).toContain('Figma MCP server');
    expect(PROTOTYPE_DESIGN_RULES).toContain("the repo's own components and design tokens");
    expect(PROTOTYPE_DESIGN_RULES).toContain('Never migrate the database or change its schema');
    expect(PROTOTYPE_DESIGN_RULES).toContain("mocked in the backend's response");
  });
});

describe('a prototype run sits in Build and never moves on', () => {
  test('it starts in Build, marked a prototype', () => {
    const run = proto();

    expect(run.stage).toBe('build');
    expect(runData(run, 'working')).toMatchObject({
      stage: 'build',
      prototype: true,
      state: 'running',
    });
  });

  const moves: [string, Move][] = [
    ['stage-done build', { type: 'stage-done', stage: 'build', report: null }],
    ['judge', { type: 'judge', answer: true, reason: 'r' }],
    ['checks', { type: 'checks', green: true }],
    ['review', { type: 'review', findings: 0, report: null, regression: [] }],
    ['verify', { type: 'verify', phase: 'after', result: 'pass', report: 'r', regression: [] }],
  ];

  test.each(moves)('%s is refused prototype-never-ships', (_, move) => {
    const stepped = step(proto(), move, T(5));

    expect(!stepped.ok && stepped.code).toBe(PROTOTYPE_NEVER_SHIPS);
  });

  test('no pull request: abe factory pr is refused too', () => {
    expect(prRefusal(proto())?.code).toBe(PROTOTYPE_NEVER_SHIPS);
  });

  test('what it takes: Needs you and its answer, the board, its end', () => {
    expect([...PROTOTYPE_TAKES].sort()).toEqual([
      'answered',
      'card-moved',
      'needs-you',
      'prototype-dropped',
    ]);
    const waiting = step(proto(), { type: 'needs-you', reason: 'asks' }, T(1));

    expect(waiting.ok && waiting.run.stage).toBe('build');
    const cleared = { at: T(9), worktree: 'removed' as const, why: null };
    const dropped = step(proto(), { type: 'prototype-dropped', cleared }, T(9));

    expect(dropped.ok && dropped.run.cleared).toEqual(cleared);
    expect(dropped.ok && dropped.run.stage).toBe('build');
  });

  test('a card run is no prototype: prototype-dropped is refused, it moves as before', () => {
    const run = newRun({
      session: '4-cd34',
      card: 4,
      title: 'x',
      repo: '/r',
      worktree: '/w',
      at: T(0),
    });
    const dropped = step(
      run,
      { type: 'prototype-dropped', cleared: { at: T(1), worktree: 'gone', why: null } },
      T(1),
    );

    expect(run.stage).toBe('spec');
    expect(run.prototype).toBe(false);
    expect(!dropped.ok && dropped.code).toBe('not-a-prototype');
  });
});

describe("a session's kind", () => {
  const of = { id: 'proto-1a2b3c', card: 4 };

  test.each([
    [{ card: 4, prototype: null }, 'card'],
    [{ card: null, prototype: { ...of, card: null } }, 'prototype'],
    [{ card: 4, prototype: of }, 'prototype'],
    [{ card: null, prototype: null, abe: { repo: '/r' } }, 'abe'],
  ] as const)('%j is %s', (s, kind) => {
    expect(withKind(s).kind).toBe(kind);
  });
});

describe('To the Factory keeps the prototype in the org store, the card launched with it as reference', () => {
  const diff =
    'diff --git a/src/total.ts b/src/total.ts\n+export const vat = 1;\ndiff --git a/src/vat.ts b/src/vat.ts\n+VAT 25 %\n';
  const shown: CodeShown = {
    branch: 'proto/4-show-vat',
    base: 'main',
    commit: 'c0ffee0123456789abcdef0123456789abcdef01',
    diff,
    screenshots: [{ n: 1, what: 'VAT under the total' }],
  };
  const AT = '2026-10-23T04:00:00.000Z';
  const screenshots = [{ n: 1, file: '1.png', what: 'VAT under the total', at: AT }];
  const plan = (n: number) =>
    codeUploadPlan({
      prototype: 'proto-c0ffee',
      at: AT,
      repo: 'shop',
      remote: 'git@github.com:example/shop.git',
      card: 4,
      n,
      shown,
      screenshots,
    });

  test("the card's comment is the prototype's line alone: no spec issue", () => {
    expect(diffFiles(diff)).toBe(2);
    expect(codeCardComment(shown)).toBe(
      'Prototype · proto/4-show-vat at c0ffee0 · 2 files · 1 screenshot',
    );
  });

  test("the diff, each screenshot, then meta.json last, under the card's version folder", () => {
    const { meta, uploads } = plan(1);

    expect(uploads.map((u) => u.key)).toEqual([
      'prototypes/shop/4/v1/prototype.diff',
      'prototypes/shop/4/v1/screenshots/1.png',
      'prototypes/shop/4/v1/meta.json',
    ]);
    expect(uploads[0]).toMatchObject({ text: diff });
    expect(meta).toMatchObject({
      version: 1,
      card: 4,
      repo: 'shop',
      branch: 'main',
      commit: shown.commit,
      spec: null,
      changes: [],
      mocks: [],
      code: { branch: 'proto/4-show-vat', diff: 'prototype.diff' },
      screenshots: [{ n: 1, what: 'VAT under the total', file: 'screenshots/1.png' }],
    });
  });

  test('its version: the one this prototype has (a retry replaces it), else the next, else v1', () => {
    const index = (prototype: string, n: number) =>
      withUploaded(undefined, { ...plan(n).meta, prototype });

    expect(codeStoreVersion(undefined, 'proto-c0ffee')).toBe(1);
    expect(codeStoreVersion(index('proto-c0ffee', 1), 'proto-c0ffee')).toBe(1);
    expect(codeStoreVersion(index('proto-aaaaaa', 2), 'proto-c0ffee')).toBe(3);
  });

  test("the run's prompt names the diff, never injected changes, and never skips Spec", () => {
    const { meta } = plan(1);
    const prompt = referencePrompt({ meta, dir: '.scratch/4/prototype' });

    expect(prompt).toContain('Spec is not skipped');
    expect(prompt).not.toContain('Skip Spec');
    expect(prompt).toContain('A prototype shows the idea in throwaway code');
    expect(prompt).toContain('`prototype.diff`');
    expect(prompt).toContain('`PROTOTYPE.md`');
    expect(prompt).toContain('`screenshots/`');
    expect(prompt).toContain('never paste its diff');
    expect(prompt).not.toContain('injected');
    expect(prototypeReadme(meta)).toContain('throwaway code on proto/4-show-vat');
  });

  test('the run reference reads back as the code kind, with no spec issue', () => {
    const run = runReference(plan(1).meta);

    expect(RunReference.parse(run)).toEqual({
      spec: null,
      prototype: { kind: 'code', branch: 'proto/4-show-vat', sha: 'c0ffee0' },
      dir: '.scratch/4/prototype',
    });
  });
});
