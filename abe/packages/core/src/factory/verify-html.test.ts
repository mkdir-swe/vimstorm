/** Verify's HTML report: what the sanitiser keeps of the verify kit, and what it strips. */
import { describe, expect, test } from 'bun:test';
import {
  type VerifyHtml,
  type VerifyKitPart,
  verifyHtmlOf,
  verifyHtmlSources,
  verifyHtmlText,
} from './verify-html';

const EVIDENCE = new Set([
  'verify/evidence/cart/before.png',
  'verify/evidence/cart/after.png',
  'verify/evidence/cart/drive.webm',
  'verify/evidence/cart/drive.gif',
  'verify/evidence/cli/run.txt',
]);
const there = (path: string) => EVIDENCE.has(path);

/** One feature of the kit around `inner`. */
const feature = (inner: string, attrs = 'data-feature="cart" data-verdict="pass"') =>
  `<section class="ab-verify-feature" ${attrs}><h4 class="ab-verify-head">Cart</h4>${inner}</section>`;
const SHOT = (src: string, more = '') =>
  `<figure class="ab-verify-shot"><img src="${src}" alt="Cart"${more}><figcaption>After</figcaption></figure>`;
const KEPT_SHOT: VerifyKitPart = {
  kind: 'shot',
  shot: { src: 'verify/evidence/cart/after.png', alt: 'Cart', caption: 'After' },
};

describe('the kit kept', () => {
  test('each part, typed, its Evidence from .scratch/<card>/', () => {
    const got = verifyHtmlOf(
      [
        '<!-- the verify agent wrote this -->',
        feature(
          [
            '<div class="ab-verify-pair">',
            SHOT('verify/evidence/cart/before.png'),
            SHOT('./verify/evidence/cart/after.png'),
            '</div>',
            '<figure class="ab-verify-recording"><video src="verify/evidence/cart/drive.webm" poster="verify/evidence/cart/after.png"></video><img src="verify/evidence/cart/drive.gif" alt=""><figcaption>1 → 3</figcaption></figure>',
            '<div class="ab-verify-judged"><p>Read the total:</p><p><code>86.97</code> &amp; shipping once.</p></div>',
            '<figure class="ab-verify-transcript" data-src="verify/evidence/cli/run.txt"><figcaption>The CLI</figcaption></figure>',
          ].join('\n'),
        ),
        feature(
          '<p class="ab-verify-not-driven">No search code changed.</p>',
          'data-feature="search" data-verdict="not-driven"',
        ),
      ].join('\n'),
      there,
    );

    expect(got.stripped).toEqual([]);
    expect(got.features).toEqual([
      {
        feature: 'cart',
        title: 'Cart',
        verdict: 'pass',
        parts: [
          {
            kind: 'pair',
            before: { src: 'verify/evidence/cart/before.png', alt: 'Cart', caption: 'After' },
            after: { src: 'verify/evidence/cart/after.png', alt: 'Cart', caption: 'After' },
          },
          {
            kind: 'recording',
            src: 'verify/evidence/cart/drive.webm',
            gif: 'verify/evidence/cart/drive.gif',
            poster: 'verify/evidence/cart/after.png',
            caption: '1 → 3',
          },
          { kind: 'judged', text: 'Read the total:\n86.97 & shipping once.' },
          {
            kind: 'transcript',
            src: 'verify/evidence/cli/run.txt',
            caption: 'The CLI',
            text: '',
          },
        ],
      },
      {
        feature: 'search',
        title: 'Cart',
        verdict: 'not-driven',
        parts: [{ kind: 'not-driven', text: 'No search code changed.' }],
      },
    ]);
    expect(verifyHtmlSources(got)).toEqual([
      'verify/evidence/cart/before.png',
      'verify/evidence/cart/after.png',
      'verify/evidence/cart/drive.webm',
      'verify/evidence/cart/drive.gif',
      'verify/evidence/cli/run.txt',
    ]);
  });

  test('written back as the kit’s own HTML, which reads back the same', () => {
    const got = verifyHtmlOf(
      `<script>x()</script>${feature(SHOT('verify/evidence/cart/after.png', ' onerror="x()"'))}`,
      there,
    );
    const text = verifyHtmlText(got);

    expect(text).not.toContain('script');
    expect(text).not.toContain('onerror');
    expect(verifyHtmlOf(text, there)).toEqual({ features: got.features, stripped: [] });
  });
});

describe('where each proof was taken', () => {
  const WHERE = (more: string) =>
    `<figure class="ab-verify-shot" ${more}><img src="verify/evidence/cart/after.png" alt="Cart"><figcaption>After</figcaption></figure>`;

  test('its page, account and env kept, typed, and written back', () => {
    const got = verifyHtmlOf(
      feature(
        WHERE('data-url="http://localhost:5173/cart?id=3" data-account=" buyer  (test) "') +
          '<figure class="ab-verify-recording" data-url="https://dev.shop.example/cart" data-account="admin"><video src="verify/evidence/cart/drive.webm"></video></figure>',
        'data-feature="cart" data-verdict="pass" data-env="Local"',
      ),
      there,
    );

    expect(got.stripped).toEqual([]);
    expect(got.features[0]?.env).toBe('local');
    expect(got.features[0]?.parts).toEqual([
      {
        kind: 'shot',
        shot: {
          src: 'verify/evidence/cart/after.png',
          alt: 'Cart',
          caption: 'After',
          url: 'http://localhost:5173/cart?id=3',
          account: 'buyer (test)',
        },
      },
      {
        kind: 'recording',
        src: 'verify/evidence/cart/drive.webm',
        gif: null,
        poster: null,
        caption: '',
        url: 'https://dev.shop.example/cart',
        account: 'admin',
      },
    ]);
    const text = verifyHtmlText(got);

    expect(text).toContain('data-env="local"');
    expect(text).toContain(
      'data-url="http://localhost:5173/cart?id=3" data-account="buyer (test)"',
    );
    expect(verifyHtmlOf(text, there)).toEqual(got);
  });

  test.each<[string, string, string]>([
    [
      'a javascript: URL',
      'data-url="javascript:alert(1)"',
      'data-url="javascript:alert(1)" on <figure> is no http(s) URL',
    ],
    [
      'a file: URL',
      'data-url="file:///etc/passwd"',
      'data-url="file:///etc/passwd" on <figure> is no http(s) URL',
    ],
    [
      'no URL at all',
      'data-url="the cart page"',
      'data-url="the cart page" on <figure> is no http(s) URL',
    ],
    [
      'a sign-in in the URL',
      'data-url="https://buyer:hunter2@shop.example/cart"',
      'data-url on <figure> holds a sign-in',
    ],
    [
      'an overlong URL',
      `data-url="https://shop.example/${'a'.repeat(500)}"`,
      'data-url on <figure> longer than 500',
    ],
    [
      'an overlong account',
      `data-account="${'b'.repeat(81)}"`,
      'data-account on <figure> longer than 80',
    ],
  ])('%s: stripped, the shot kept', (_, more, why) => {
    const got = verifyHtmlOf(feature(WHERE(more)), there);

    expect(got.features[0]?.parts).toEqual([KEPT_SHOT]);
    expect(got.stripped).toEqual([why]);
  });

  test('an env not local, dev or test: stripped, the feature kept', () => {
    const got = verifyHtmlOf(
      feature(
        SHOT('verify/evidence/cart/after.png'),
        'data-feature="cart" data-verdict="pass" data-env="prod"',
      ),
      there,
    );

    expect(got.features[0]?.env).toBeUndefined();
    expect(got.features[0]?.parts).toEqual([KEPT_SHOT]);
    expect(got.stripped).toEqual(['data-env="prod" on cart: not local, dev or test']);
  });
});

describe('stripped before render', () => {
  const kept = (v: VerifyHtml) => v.features.flatMap((f) => f.parts);

  test.each<[string, string, VerifyKitPart[], string[]]>([
    [
      'a script, its content too',
      `<script>document.title = "x"</script>${feature(SHOT('verify/evidence/cart/after.png'))}<SCRIPT src="https://x.io/a.js"></SCRIPT>`,
      [KEPT_SHOT],
      ['<script>'],
    ],
    [
      'an inline handler; the image kept',
      feature(SHOT('verify/evidence/cart/after.png', ' onerror="alert(1)" onload=alert(2)')),
      [KEPT_SHOT],
      ['onerror on <img>', 'onload on <img>'],
    ],
    [
      'an inline style and a class beyond the kit’s',
      feature(
        '<div class="ab-verify-judged big" style="background:url(https://x.io/t.png)">Read it.</div>',
      ),
      [{ kind: 'judged', text: 'Read it.' }],
      ['class "big" on <div>', 'style on <div>'],
    ],
    [
      'an external image',
      feature(SHOT('https://x.io/track.png')),
      [],
      [`<img src="https://x.io/track.png"> is not the run's Evidence (a URL)`],
    ],
    [
      'a protocol-relative image',
      feature(SHOT('//x.io/track.png')),
      [],
      [`<img src="//x.io/track.png"> is not the run's Evidence (a URL)`],
    ],
    [
      'a javascript: URL, however cased or encoded',
      feature(SHOT('JavaScript:alert(1)//.png') + SHOT('%6Aavascript:alert(1)//.png')),
      [],
      [
        `<img src="JavaScript:alert(1)//.png"> is not the run's Evidence (a URL)`,
        `<img src="%6Aavascript:alert(1)//.png"> is not the run's Evidence (a URL)`,
      ],
    ],
    [
      'a data: recording',
      feature(
        '<figure class="ab-verify-recording"><video src="data:video/webm;base64,AAAA"></video></figure>',
      ),
      [],
      [
        `<video src="data:video/webm;base64,AAAA"> is not the run's Evidence (a URL)`,
        "a recording with no <video> or GIF in the run's Evidence",
      ],
    ],
    [
      'a path up out of the Evidence, plain or encoded',
      feature(
        SHOT('verify/../../../.ssh/id.png') +
          SHOT('verify/%2e%2e/%2e%2e/x.png') +
          SHOT('/home/me/secret.png') +
          SHOT('~/x.png'),
      ),
      [],
      [
        `<img src="verify/../../../.ssh/id.png"> is not the run's Evidence (up out of .scratch/<card>/)`,
        `<img src="verify/%2e%2e/%2e%2e/x.png"> is not the run's Evidence (up out of .scratch/<card>/)`,
        `<img src="/home/me/secret.png"> is not the run's Evidence (outside .scratch/<card>/)`,
        `<img src="~/x.png"> is not the run's Evidence (outside .scratch/<card>/)`,
      ],
    ],
    [
      'a file not in the Evidence, or not of its part’s kind',
      feature(
        SHOT('verify/evidence/cart/gone.png') +
          SHOT('verify/evidence/cli/run.txt') +
          '<figure class="ab-verify-transcript" data-src="verify/evidence/cart/after.png"></figure>',
      ),
      [],
      [
        `<img src="verify/evidence/cart/gone.png"> is not in the run's Evidence`,
        '<img src="verify/evidence/cli/run.txt"> is not a file of the kind its part shows',
        '<figure data-src="verify/evidence/cart/after.png"> is not a file of the kind its part shows',
      ],
    ],
    [
      'a pair of two After shots: no Before first, so its shots apart',
      feature(
        '<div class="ab-verify-pair">' +
          SHOT('verify/evidence/cart/after.png') +
          SHOT('verify/evidence/cart/after.png') +
          '</div>',
      ),
      [KEPT_SHOT, KEPT_SHOT],
      ['a pair whose first shot is no Before one (before-*): its two shots drawn apart'],
    ],
    [
      'an unknown tag, with what it holds',
      `<marquee>hi</marquee>${feature('<iframe src="https://x.io"></iframe><div class="ab-verify-judged">Read <blink>it</blink> <a href="javascript:x()">here</a>.</div><svg><image href="https://x.io/a.png"/></svg>')}`,
      [{ kind: 'judged', text: 'Read here.' }],
      ['<marquee>', '<iframe>', '<blink>', 'href on <a>', '<svg>'],
    ],
    [
      'a transcript written inline: only its file counts',
      feature('<figure class="ab-verify-transcript"><pre>$ rm -rf /</pre></figure>'),
      [],
      ['a transcript written inline: give its file as data-src', `<figure data-src=""> has no src`],
    ],
    [
      'a feature with no verdict, or none named',
      feature(SHOT('verify/evidence/cart/after.png'), 'data-feature="cart"') +
        feature('', 'data-verdict="pass"'),
      [],
      [
        'cart with no data-verdict of pass, fail or not-driven',
        'a feature with no data-feature (its file in the Feature map)',
      ],
    ],
  ])('%s', (_, html, parts, stripped) => {
    const got = verifyHtmlOf(html, there);

    expect(kept(got)).toEqual(parts);
    expect(got.stripped).toEqual(stripped);
  });
});
