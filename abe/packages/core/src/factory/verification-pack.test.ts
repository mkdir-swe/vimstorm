/** The Verification pack as written at install, its proof, and a run's verdicts per feature. */
import { describe, expect, test } from 'bun:test';
import {
  featureHtmlFindings,
  featureReportFindings,
  featureSurfaces,
  installProofFindings,
  packFindings,
  packPaths,
  packRefusal,
  type PackSurface,
  packSurface,
} from './verification-pack';

const REPO = '/u/demo-shop';
const SKILL = [
  '---',
  'name: verify-demo-shop',
  'description: Drives demo-shop in a headless browser. Use to verify a change.',
  '---',
  '',
  '# Verify demo-shop',
  '',
  '## Launch',
  '## Doctor',
  '## Drive (headless Playwright)',
  '## Evidence',
  '## Cleanup',
  '',
].join('\n');
const MAP =
  '# Map\n\n- [Cart](./cart.md) adds items.\n- [Checkout](checkout.md) places an order.\n';
const FEATURE =
  '# Cart\n\nText.\n\n## Sub-features\n\n## How to get to it (user POV)\n\n## Driving it with Playwright\n\n## Gotchas\n';

const codes = (f: readonly { code: string }[]) => f.map((x) => x.code);

type Pack = Parameters<typeof packFindings>[0];

describe('packFindings: the pack the install wrote', () => {
  const good: Pack = {
    repo: REPO,
    skill: SKILL,
    map: MAP,
    features: new Map([
      ['cart', FEATURE],
      ['checkout', FEATURE],
    ]),
    listed: ['README.md', 'cart.md', 'checkout.md'],
  };

  test.each<[string, Partial<Pack>, string[]]>([
    ['a whole pack', {}, []],
    ['no skill', { skill: undefined }, ['no-verify-skill']],
    [
      'another name',
      { skill: SKILL.replace('verify-demo-shop', 'shop-verify') },
      ['verify-skill-shape'],
    ],
    ['no Doctor', { skill: SKILL.replace('## Doctor\n', '') }, ['verify-skill-shape']],
    ['no feature map', { map: undefined }, ['no-feature-map']],
    ['a map that links nothing', { map: '# Map\n' }, ['no-feature-map']],
    [
      'a linked feature not there',
      {
        features: new Map([
          ['cart', FEATURE],
          ['checkout', undefined],
        ]),
      },
      ['feature-shape'],
    ],
    [
      'a feature file the map does not link',
      { listed: ['README.md', 'cart.md', 'checkout.md', 'search.md'] },
      ['feature-shape'],
    ],
    [
      'a feature without its four H2s in order',
      {
        features: new Map([
          ['cart', FEATURE.replace('## Gotchas\n', '')],
          ['checkout', FEATURE],
        ]),
      },
      ['feature-shape'],
    ],
    [
      'a feature that says a surface no pack has',
      {
        features: new Map([
          ['cart', `---\nsurface: grpc\n---\n${FEATURE}`],
          ['checkout', FEATURE],
        ]),
      },
      ['feature-shape'],
    ],
  ])('%s', (_, change, want) => {
    expect(codes(packFindings({ ...good, ...change }))).toEqual(want);
  });

  test('named for the checkout folder', () => {
    expect(packPaths(REPO).map).toEqual('.claude/skills/verify-demo-shop/features/README.md');
  });
});

test.each<[string, PackSurface, [string, string[]][], string[]]>([
  [
    'one feature with a screenshot and a recording',
    'web',
    [['cart', ['cart.png', 'cart.webm']]],
    [],
  ],
  ['no proof', 'web', [], ['install-unproven']],
  ['a screenshot only', 'web', [['cart', ['cart.png']]], ['install-unproven']],
  ['a feature the map has not', 'web', [['search', ['s.png', 's.webm']]], ['install-unproven']],
  // no UI: a transcript in place of a screenshot, no recording needed
  ['a CLI with a transcript', 'cli', [['cart', ['cart.txt']]], []],
  ['an API with its response', 'api', [['cart', ['order.json']]], []],
  ['a web app with a transcript only', 'web', [['cart', ['cart.txt']]], ['install-unproven']],
])('installProofFindings: %s (%s)', (_, surface, proofs, want) => {
  expect(
    codes(
      installProofFindings({ features: ['cart', 'checkout'], proofs: new Map(proofs), surface }),
    ),
  ).toEqual(want);
});

test.each<[string, string | undefined, PackSurface, string[]]>([
  ['none said: web', SKILL, 'web', []],
  ['under metadata', SKILL.replace('---\n\n#', 'metadata:\n  surface: cli\n---\n\n#'), 'cli', []],
  ['top level', SKILL.replace('---\n\n#', "surface: 'api'\n---\n\n#"), 'api', []],
  [
    'another word',
    SKILL.replace('---\n\n#', 'surface: tui\n---\n\n#'),
    'web',
    ['verify-skill-shape'],
  ],
])('packSurface: %s', (_, skill, surface, want) => {
  expect([
    packSurface(skill),
    codes(
      packFindings({
        repo: REPO,
        skill,
        map: MAP,
        features: new Map([
          ['cart', FEATURE],
          ['checkout', FEATURE],
        ]),
        listed: [],
      }),
    ),
  ]).toEqual([surface, want]);
});

describe("featureReportFindings: a run's verdicts per mapped feature", () => {
  const THERE = ['verify/evidence/cart/add.png', 'verify/evidence/cart/drive.webm'];
  const report = (lines: string[]) =>
    `# Verify after\n\n## Features\n\n${lines.join('\n')}\n\n## Regression\n\n- tests: pass\n`;
  const CART =
    '- `cart` pass. Judged by: the badge reads 2 after two adds. Evidence: verify/evidence/cart/add.png, verify/evidence/cart/drive.webm';
  const CHECKOUT = '- `checkout` not driven. Why: the diff touches no checkout code.';

  test.each<[string, string, string[]]>([
    ['each driven with proof, the other not driven with why', report([CART, CHECKOUT]), []],
    [
      'where it was driven after its Evidence',
      report([`${CART}. Where: local · http://localhost:5173/cart · as buyer`, CHECKOUT]),
      [],
    ],
    ['no Features section', '# Verify after\n\n1. done\n', ['feature-not-listed']],
    ['a mapped feature left out', report([CART]), ['feature-not-listed']],
    [
      'a feature the map has not',
      report([CART, CHECKOUT, '- `search` not driven. Why: x']),
      ['feature-unknown'],
    ],
    [
      'a verdict with no how',
      report([CART.replace(/Judged by: .*?\. /, ''), CHECKOUT]),
      ['feature-unjudged'],
    ],
    [
      'no recording',
      report([CART.replace(', verify/evidence/cart/drive.webm', ''), CHECKOUT]),
      ['feature-unproven'],
    ],
    [
      'evidence that is not there',
      report([CART.replace('add.png', 'gone.png'), CHECKOUT]),
      ['feature-unproven'],
    ],
    [
      'evidence out of the card folder',
      report([CART.replace('verify/evidence/cart/add.png', '../x.png'), CHECKOUT]),
      ['feature-unproven'],
    ],
    [
      'not driven with no why',
      report([CART, '- `checkout` not driven.']),
      ['not-driven-no-reason'],
    ],
    [
      'a bullet that is no verdict',
      report([CART, CHECKOUT, '- looked fine']),
      ['feature-unjudged'],
    ],
  ])('%s', (_, text, want) => {
    expect(
      codes(
        featureReportFindings({
          features: ['cart', 'checkout'],
          report: 'verify-after.md',
          text,
          there: (p) => THERE.includes(p),
        }),
      ),
    ).toEqual(want);
  });
});

describe('a feature with its own surface in a web pack', () => {
  const surfaces = featureSurfaces(
    new Map([
      ['health', `---\nsurface: http\n---\n${FEATURE}`],
      ['cart', FEATURE],
    ]),
    'web',
  );
  const text = (feature: string, evidence: string) =>
    `# Verify after\n\n## Features\n\n- \`${feature}\` pass. Judged by: 200 {"ok":true}. Evidence: ${evidence}\n`;
  const findings = (feature: string, evidence: string) =>
    featureReportFindings({
      features: [feature],
      report: 'verify-after.md',
      text: text(feature, evidence),
      there: () => true,
      surface: 'web',
      surfaces,
    });

  test("surface: http is an api; the rest keep the pack's", () => {
    expect([...surfaces]).toEqual([
      ['health', 'api'],
      ['cart', 'web'],
    ]);
  });

  test('its request/response transcript proves it', () => {
    expect(findings('health', 'verify/evidence/health/get.json')).toEqual([]);
  });

  test("a web feature's refusal names its surface, what proves it and how to declare another", () => {
    const said = packRefusal(findings('cart', 'verify/evidence/cart/get.json'));

    expect(said?.code).toBe('feature-unproven');
    expect(said?.message).toContain('cart (surface web, proven by a screenshot and a recording)');
    expect(said?.message).toContain('`surface: api`');
  });
});

describe("featureHtmlFindings: the After pass's HTML report says what its ## Features says", () => {
  const TEXT =
    '# Verify after\n\n## Features\n\n- `cart` pass. Judged by: x. Evidence: verify/evidence/cart/a.png\n- `checkout` not driven. Why: untouched.\n';
  const section = (feature: string, verdict: string) =>
    `<section class="ab-verify-feature" data-feature="${feature}" data-verdict="${verdict}"><h4 class="ab-verify-head">${feature}</h4></section>`;
  const findings = (html: string | undefined) =>
    featureHtmlFindings({
      report: 'verify-after.md',
      text: TEXT,
      html: html === undefined ? undefined : { path: 'verify-after.html', text: html },
    });

  test.each<[string, string | undefined, string[]]>([
    ['the same verdicts', section('cart', 'pass') + section('checkout', 'not-driven'), []],
    ['no HTML report', undefined, ['no-verify-html']],
    [
      'a different verdict',
      section('cart', 'fail') + section('checkout', 'not-driven'),
      ['feature-html-differs'],
    ],
    ['a feature left out of the HTML', section('cart', 'pass'), ['feature-html-differs']],
    [
      'a feature only the HTML has',
      section('cart', 'pass') + section('checkout', 'not-driven') + section('search', 'pass'),
      ['feature-html-differs'],
    ],
    [
      'a section with no verdict the kit knows',
      section('cart', 'pass') + section('checkout', 'skipped'),
      ['feature-html-differs'],
    ],
  ])('%s', (_, html, want) => {
    expect(codes(findings(html))).toEqual(want);
  });

  test('the refusal names each mismatching feature, and says to write the HTML from the verify kit', () => {
    expect(packRefusal(findings(section('cart', 'fail') + section('search', 'pass')))).toEqual({
      code: 'feature-html-differs',
      message:
        "verify-after.html says cart fail, ## Features says pass; verify-after.html has no section for checkout, which ## Features says not-driven; verify-after.html has a section for search, which ## Features does not list. Give each feature's section in the HTML report the verdict its ## Features line says",
    });
    expect(packRefusal(findings(undefined))?.message).toBe(
      "verify-after.md has no HTML report (--html <file>). Write the HTML report from the verify kit (the verify skill's The HTML report: one section per mapped feature, its verdict as ## Features says) and record it with --html",
    );
  });
});
