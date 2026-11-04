import { describe, expect, test } from 'bun:test';
import {
  hasPrototypeLine,
  MAKE_CARD_SKILL,
  NEW_CARD,
  type OrgPrototypeVersion,
  prototypeLinkLine,
  prototypeReadme,
  referencePrompt,
  runReference,
  storeRepoName,
  withPrototypeSection,
  withUploaded,
} from './make-card';

const AT = '2026-10-23T03:00:00.000Z';
const SHA = '3f2a9c1'.padEnd(40, '0');

/** A version Prototype mode uploaded before 3.3: its changes and mocks, as the store keeps them. */
const META: OrgPrototypeVersion = {
  v: 1,
  prototype: 'proto-abc123',
  version: 3,
  at: AT,
  card: 4,
  repo: 'demo-shop',
  remote: 'git@github.com:o/demo-shop.git',
  branch: 'main',
  commit: SHA,
  spec: null,
  changes: [
    {
      n: 1,
      what: 'the total in bold',
      at: AT,
      kind: 'css',
      target: '#total',
      file: 'changes/1.css',
    },
    {
      n: 3,
      what: 'the VAT line under the total',
      at: AT,
      kind: 'js',
      target: null,
      file: 'changes/3.js',
    },
  ],
  mocks: [{ n: 2, what: 'the VAT rate', at: AT, route: 'GET /api/vat', file: 'mocks/2.json' }],
  screenshots: [{ n: 1, what: 'the cart with the VAT line', at: AT, file: 'screenshots/1.png' }],
  code: null,
};

describe('the make-card skill', () => {
  test('as a one-shot: the card part, in plain words, no frontmatter', () => {
    expect(MAKE_CARD_SKILL).toContain('## The card');
    expect(MAKE_CARD_SKILL).toContain('No em dashes');
    expect(MAKE_CARD_SKILL).not.toContain('Can we do this');
    expect(MAKE_CARD_SKILL).not.toMatch(/^---/);
  });
});

describe('the org store', () => {
  test.each([
    [{ remote: 'git@github.com:o/demo-shop.git', repo: '/x/y' }, 'demo-shop'],
    [{ remote: 'https://github.com/o/shop', repo: '/x/y' }, 'shop'],
    [{ remote: null, repo: '/home/po/My Shop' }, 'My-Shop'],
    [{ remote: 'https://gitlab.example/o/r.git', repo: '/x/shop' }, 'shop'],
    [{ remote: null, repo: '/' }, 'repo'],
  ])('the repo in keys: %o → %s', (o, name) => {
    expect(storeRepoName(o)).toBe(name);
  });

  test('prototype.json keeps each version once, in order; a spec issue made before #351 stays', () => {
    const v3 = META;
    const v1 = { ...META, version: 1 };
    const index = withUploaded(withUploaded(undefined, v3), v1);
    const spec = {
      repo: 'o/demo-shop',
      number: 88,
      url: 'https://github.com/o/demo-shop/issues/88',
    };

    expect(index.versions.map((v) => v.n)).toEqual([1, 3]);
    expect(index.spec).toBeNull();
    expect(withUploaded(index, v3).versions).toHaveLength(2);
    expect(withUploaded({ ...index, spec }, v3).spec).toEqual(spec);
  });
});

describe('the link line and the section', () => {
  const meta = META;

  test('Prototype v<n>: its changes, mocks, commit and address', () => {
    expect(prototypeLinkLine(meta)).toBe(
      'Prototype v3 · 3 changes · mock GET /api/vat · at 3f2a9c1 · prototype://demo-shop/4/v3',
    );
    expect(hasPrototypeLine([{ text: 'prototype://demo-shop/4/v2' }], meta)).toBe(false);
  });

  test('a preview before the card exists names the new card', () => {
    const preview = { ...META, card: NEW_CARD };

    expect(prototypeLinkLine(preview)).toContain('prototype://demo-shop/<new card>/v3');
  });

  test.each([
    ['', '## Prototype\n\nLINE'],
    ['Own words.', 'Own words.\n\n## Prototype\n\nLINE'],
    ['## Why\n\nA.\n\n## Prototype\n\nOLD', '## Why\n\nA.\n\n## Prototype\n\nLINE'],
    ['## Prototype\n\nOLD\n\n## What\n\nB.', '## Prototype\n\nLINE\n\n## What\n\nB.'],
  ])('a card that exists keeps its text: %j gets its Prototype section', (before, after) => {
    expect(withPrototypeSection(before, meta)).toBe(after.replace('LINE', prototypeLinkLine(meta)));
  });

  test('the reference a Factory run gets: a question, Spec not skipped, PROTOTYPE.md first', () => {
    const text = referencePrompt({ meta, dir: '.scratch/4/prototype' });

    expect(text).toContain('## Prototype (a question, not a spec)');
    expect(text).toContain('Spec is not skipped');
    expect(text).not.toContain('Skip Spec');
    expect(text).toContain('.scratch/4/prototype: `PROTOTYPE.md` first');
    expect(text).toContain('`mocks/`');
    expect(text).toContain('`screenshots/`');
    expect(text).toContain('never paste its CSS, JS or mocks');
    expect(runReference(meta)).toEqual({
      spec: null,
      prototype: { kind: 'store', url: 'prototype://demo-shop/4/v3' },
      dir: '.scratch/4/prototype',
    });
  });

  test('PROTOTYPE.md: the link line, each change in words with its target, the mocks as data questions, the screenshots, a mock-up', () => {
    const md = prototypeReadme(meta);

    expect(md).toStartWith('# Prototype v3 of AB#4\n\nPrototype v3 · 3 changes');
    expect(md).toContain('A mock-up: question it, never copy it.');
    expect(md).toContain('1. CSS: the total in bold (on `#total`) (`changes/1.css`)');
    expect(md).toContain('2. Mock GET /api/vat: the VAT rate (`mocks/2.json`; a data question');
    expect(md).toContain('3. JS: the VAT line under the total (`changes/3.js`)');
    expect(md).toContain('## Screenshots\n\n1. the cart with the VAT line (`screenshots/1.png`)');
  });
});
