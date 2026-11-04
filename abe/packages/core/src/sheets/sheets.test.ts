import { describe, expect, test } from 'bun:test';
import {
  listOrder,
  orgKeyProblem,
  parseSheetRef,
  planSave,
  rankSheets,
  type SheetMeta,
  type SheetRef,
  sheetOfInfoKey,
  sheetSlug,
  type SheetSummary,
  selfContainedProblems,
} from './sheets';

const page = (head: string, body = '') =>
  `<!doctype html>\n<html><head><title>T</title>${head}</head><body>${body}</body></html>`;

describe('the self-contained check', () => {
  test.each([
    ['an inline table', page('<style>td{color:red}</style>', '<table><tr><td>1</td></tr></table>')],
    ['a data: image', page('', '<img src="data:image/png;base64,iVBORw0KGgo=">')],
    ['inline script and its data', page('', '<script>const rows=[1,2];render(rows)</script>')],
    [
      'a data: url() in css',
      page('<style>b{background:url(data:image/svg+xml,%3Csvg%3E)}</style>'),
    ],
    ['an svg fragment', page('', '<svg><use href="#dot"/><rect fill="url(#g)"/></svg>')],
    ['a link to read elsewhere', page('', '<a href="https://example.test/spec">spec</a>')],
    ['markup shown as text', page('', '<pre>&lt;img src="https://x.test/a.png"&gt;</pre>')],
    ['a comment', page('<!-- <script src="https://cdn.test/x.js"></script> -->')],
    ['words in the page', page('', '<p>we fetch("the data") from new WebSocket(s)</p>')],
    ['a method called fetch', page('', '<script>store.fetch("rows"); prefetch("x")</script>')],
    ['fetch of a data: url', page('', '<script>fetch("data:text/plain,hi")</script>')],
    ['a character reference out of range', page('', '<p title="&#99999999;">x</p>')],
    ['data on a non-object', page('', '<div data="x.png"></div>')],
  ])('%s is fine', (_, html) => {
    expect(selfContainedProblems(html)).toEqual([]);
  });

  test.each([
    [
      'an external script',
      page('<script src="https://cdn.test/chart.js"></script>'),
      ['src https://cdn.test/chart.js (line 2)'],
    ],
    ['a relative image', page('', "<img src='logo.png'>"), ['src logo.png (line 2)']],
    [
      'a protocol-relative iframe',
      page('', '<iframe src=//x.test/f></iframe>'),
      ['src //x.test/f (line 2)'],
    ],
    [
      'a stylesheet',
      page('<link rel="stylesheet" href="https://fonts.test/a.css">'),
      ['href https://fonts.test/a.css (line 2)'],
    ],
    ['an icon', page('<link rel=icon href=/favicon.ico>'), ['href /favicon.ico (line 2)']],
    [
      'an svg image',
      page('', '<svg><image href="https://x.test/i.png"/></svg>'),
      ['href https://x.test/i.png (line 2)'],
    ],
    [
      '@import',
      page('<style>@import url("https://fonts.test/b.css");</style>'),
      ['@import https://fonts.test/b.css (line 2)'],
    ],
    [
      '@import a string',
      page("<style>@import 'theme.css';</style>"),
      ['@import theme.css (line 2)'],
    ],
    [
      'url(http…) in a style attribute',
      page('', '<div style="background: url(http://img.test/bg.png)"></div>'),
      ['url() http://img.test/bg.png (line 2)'],
    ],
    [
      'fetch',
      page('', '<script>\nfetch("https://api.test/rows")\n</script>'),
      ['fetch https://api.test/rows (line 3)'],
    ],
    ['fetch of a variable', page('', '<script>fetch(url)</script>'), ['fetch url (line 2)']],
    [
      'XMLHttpRequest',
      page('', "<script>const x = new XMLHttpRequest(); x.open('GET', '/rows.json');</script>"),
      ['XMLHttpRequest /rows.json (line 2)'],
    ],
    [
      'WebSocket',
      page('', "<script>new WebSocket('wss://live.test/s')</script>"),
      ['WebSocket wss://live.test/s (line 2)'],
    ],
    [
      'EventSource',
      page('', '<script>new EventSource(`/events`)</script>'),
      ['EventSource /events (line 2)'],
    ],
    [
      'an event handler',
      page('', `<button onclick="fetch('/x')">go</button>`),
      ['fetch /x (line 2)'],
    ],
    [
      'an entity-hidden src',
      page('', '<img src="&#104;ttps://x.test/a.png">'),
      ['src https://x.test/a.png (line 2)'],
    ],
    [
      'srcdoc inside an iframe',
      page('', '<iframe srcdoc="&lt;img src=&quot;https://x.test/p.png&quot;&gt;"></iframe>'),
      ['src https://x.test/p.png (line 2)'],
    ],
    [
      '@import with no space',
      page('<style>@import"https://x.test/a.css";</style>'),
      ['@import https://x.test/a.css (line 2)'],
    ],
    [
      'a quoted url() holding a )',
      page(`<style>b{background:url("https://x.test/a(1).png")}</style>`),
      ['url() https://x.test/a(1).png (line 2)'],
    ],
    [
      'a quoted url() holding a quote',
      page(`<style>b{background:url("https://x.test/it's.png")}</style>`),
      ["url() https://x.test/it's.png (line 2)"],
    ],
    [
      'srcset',
      page('', '<img srcset="data:image/png;base64,AA 1x, https://x.test/b.png 2x">'),
      ['srcset https://x.test/b.png (line 2)'],
    ],
    [
      'poster',
      page('', '<video poster="https://x.test/p.jpg"></video>'),
      ['poster https://x.test/p.jpg (line 2)'],
    ],
    [
      'object data',
      page('', '<object data="https://x.test/o.svg"></object>'),
      ['data https://x.test/o.svg (line 2)'],
    ],
    [
      'a module import',
      page(
        '',
        `<script type="module">import { a } from 'https://x.test/m.js'; import('/n.js')</script>`,
      ),
      ['import https://x.test/m.js (line 2)', 'import /n.js (line 2)'],
    ],
  ])('%s is refused', (_, html, problems) => {
    expect(selfContainedProblems(html).map((p) => p.text)).toEqual(problems);
  });

  test('every problem is named, in page order', () => {
    const html = [
      '<html><head>',
      '<link rel="stylesheet" href="a.css">',
      '<style>@import "b.css"; i { background: url(https://c.test/c.png) }</style>',
      '</head><body>',
      '<img src="d.png">',
      "<script>fetch('/e'); new WebSocket('ws://f')</script>",
      '</body></html>',
    ].join('\n');

    expect(selfContainedProblems(html).map((p) => p.text)).toEqual([
      'href a.css (line 2)',
      '@import b.css (line 3)',
      'url() https://c.test/c.png (line 3)',
      'src d.png (line 5)',
      'fetch /e (line 6)',
      'WebSocket ws://f (line 6)',
    ]);
  });
});

const summary = (s: Partial<SheetSummary> & { id: string; title: string }): SheetSummary => ({
  card: null,
  session: null,
  version: 1,
  at: '2026-10-23T10:00:00.000Z',
  attached: [],
  address: `sheet://${s.id}`,
  ...s,
});

const SHEETS = [
  summary({ id: 'cart-totals-aa', title: 'Cart totals', at: '2026-10-23T09:00:00.000Z' }),
  summary({
    id: 'checkout-timing-bb',
    title: 'Checkout timing',
    card: 4,
    at: '2026-10-23T08:00:00.000Z',
  }),
  summary({
    id: 'carrier-rates-cc',
    title: 'Carrier rates',
    session: 's1',
    at: '2026-10-23T07:00:00.000Z',
  }),
  summary({ id: 'orders-by-day-dd', title: 'Orders by day', at: '2026-10-23T11:00:00.000Z' }),
  summary({ id: 'scart-ee', title: 'Discarted items', at: '2026-10-23T06:00:00.000Z' }),
];

const ids = (sheets: readonly SheetSummary[]) => sheets.map((s) => s.id);
const NONE = { card: null, session: null };

describe('the fuzzy find', () => {
  test.each([
    [
      'a prefix, then inside a word, then letters in order',
      'cart',
      NONE,
      ['cart-totals-aa', 'scart-ee', 'carrier-rates-cc'],
    ],
    ['the exact title before a prefix', 'cart totals', NONE, ['cart-totals-aa']],
    ['a word start', 'timing', NONE, ['checkout-timing-bb']],
    [
      'letters in order, the tightest first',
      'crt',
      NONE,
      ['cart-totals-aa', 'scart-ee', 'carrier-rates-cc'],
    ],
    ['every word must match', 'ord day', NONE, ['orders-by-day-dd']],
    ['case does not matter', 'CHECKOUT', NONE, ['checkout-timing-bb']],
    ['the id matches too', 'bb', NONE, ['checkout-timing-bb']],
    ['no match', 'invoice', NONE, []],
    [
      "the current card's first",
      'c',
      { card: 4, session: null },
      ['checkout-timing-bb', 'cart-totals-aa', 'carrier-rates-cc', 'scart-ee'],
    ],
    [
      "the session's first",
      'cart',
      { card: null, session: 's1' },
      ['carrier-rates-cc', 'cart-totals-aa', 'scart-ee'],
    ],
  ])('%s', (_, query, context, expected) => {
    expect(ids(rankSheets(SHEETS, query, context))).toEqual(expected);
  });

  test('a list: the current card’s and session’s first, then newest first', () => {
    expect(ids(listOrder(SHEETS, { card: 4, session: 's1' }))).toEqual([
      'checkout-timing-bb',
      'carrier-rates-cc',
      'orders-by-day-dd',
      'cart-totals-aa',
      'scart-ee',
    ]);
  });
});

const AT = '2026-10-23T12:00:00.000Z';

const meta = (m: Partial<SheetMeta> & { id: string; title: string }): SheetMeta => ({
  card: null,
  session: null,
  versions: [{ n: 1, at: AT, bytes: 10 }],
  attached: [],
  ...m,
});

describe('a save', () => {
  test('a new title is a new Sheet at v1, its id the title’s slug and the suffix', () => {
    const plan = planSave([], {
      title: 'Cart totals',
      card: 4,
      session: null,
      at: AT,
      bytes: 9,
      suffix: 'a1b2c3',
    });

    expect(plan).toEqual({
      id: 'cart-totals-a1b2c3',
      version: 1,
      meta: {
        id: 'cart-totals-a1b2c3',
        title: 'Cart totals',
        card: 4,
        session: null,
        versions: [{ n: 1, at: AT, bytes: 9 }],
        attached: [],
      },
    });
  });

  test('the same title (any case) is the next version; a card or session not given is kept', () => {
    const before = meta({ id: 'cart-totals-x', title: 'Cart totals', card: 4, session: 's1' });
    const plan = planSave([before], {
      title: ' cart TOTALS ',
      card: null,
      session: null,
      at: AT,
      bytes: 20,
      suffix: 'zz',
    });

    expect(plan.id).toBe('cart-totals-x');
    expect(plan.version).toBe(2);
    expect(plan.meta).toMatchObject({ title: 'Cart totals', card: 4, session: 's1' });
    expect(plan.meta.versions.map((v) => v.n)).toEqual([1, 2]);
  });

  test.each([
    ['Cart totals', 'cart-totals'],
    ['  Before / after: checkout!  ', 'before-after-checkout'],
    ['Åäö räksmörgås', 'aao-raksmorgas'],
    ['日本', 'sheet'],
    ['x'.repeat(80), 'x'.repeat(40)],
  ])('slug of %j is %j', (title, slug) => {
    expect(sheetSlug(title)).toBe(slug);
  });
});

describe('refs, keys and the link line', () => {
  test.each<[string, SheetRef | undefined]>([
    ['cart-totals-a1', { kind: 'yours', id: 'cart-totals-a1' }],
    ['Cart totals', { kind: 'yours', id: 'Cart totals' }],
    ['sheet://cart-totals-a1', { kind: 'yours', id: 'cart-totals-a1' }],
    ['4/cart-totals-a1', { kind: 'card', card: 4, id: 'cart-totals-a1' }],
    ['AB#4/cart-totals-a1', { kind: 'card', card: 4, id: 'cart-totals-a1' }],
    ['sheet://4/cart-totals-a1', { kind: 'card', card: 4, id: 'cart-totals-a1' }],
    ['Before / after', { kind: 'yours', id: 'Before / after' }],
    ['4/../etc', { kind: 'yours', id: '4/../etc' }],
    ['  ', undefined],
  ])('%j', (text, ref) => {
    expect(parseSheetRef(text)).toEqual(ref);
  });

  test.each([
    ['sheets/4/cart-a1/v1.html', undefined],
    ['sheets/4/', 'an empty part'],
    ['/sheets/4', 'an empty part'],
    ['sheets/../x', '. or ..'],
    ['sheets/a b', 'a character outside A-Z a-z 0-9 . _ -'],
    ['', 'empty'],
  ])('org key %j', (key, problem) => {
    expect(orgKeyProblem(key)).toBe(problem);
  });

  test.each([
    ['sheets/4/cart-a1/sheet.json', 'cart-a1'],
    ['sheets/4/cart-a1/v1.html', undefined],
    ['sheets/44/cart-a1/sheet.json', undefined],
    ['sheets/4/x/y/sheet.json', undefined],
  ])('the Sheet of info key %j under card 4', (key, id) => {
    expect(sheetOfInfoKey(4, key)).toBe(id);
  });
});
