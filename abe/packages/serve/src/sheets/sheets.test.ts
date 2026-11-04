/**
 * `abe sheet` through the CLI seam: the real `abe` and its `serve`, Sheets in its state directory,
 * the org store a folder (`ABE_ORG_STORE=file://…`), the fake Azure DevOps for the card's link
 * line, and the Sheet's own origin read over HTTP as a browser would.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CardShowData,
  Event,
  SHEET_CSP,
  SheetAttachData,
  SheetFindData,
  SheetListData,
  SheetOpenData,
  SheetSaveData,
  SheetShowData,
} from '@abe/core';
import {
  boardLayers,
  cli,
  type Cli,
  fakeAdo,
  type FakeAdo,
  fakeAz,
  type Streaming,
} from '@abe/testing';

const PAGE = `<!doctype html>
<html><head><title>Cart totals</title>
<style>td { padding: 4px } .bar { background: url(data:image/png;base64,iVBORw0KGgo=) }</style>
</head><body>
<table id="t"></table>
<script>const rows = [["Mon", 12], ["Tue", 9]];
document.getElementById('t').innerHTML = rows.map(([d, n]) => '<tr><td>' + d + '</td><td>' + n + '</td></tr>').join('');</script>
</body></html>
`;

const REACHING = `<!doctype html>
<html><head><link rel="stylesheet" href="https://cdn.test/a.css"></head>
<body><img src="https://img.test/logo.png">
<script>fetch('https://api.test/rows').then(r => r.json())</script>
</body></html>
`;

const ok = <T>(doc: { ok: true; data: T } | { ok: false; error: { message: string } }): T => {
  if (!doc.ok) throw new Error(doc.error.message);

  return doc.data;
};

/** Two people on one org store and one fake board: you, and a teammate with a state of their own. */
const world = async () => {
  const ado = await fakeAdo();
  const az = fakeAz({ tokens: ['token-one'] });
  const files = boardLayers(ado.board);
  const store = mkdtempSync(join(tmpdir(), 'org-store-'));
  const env = {
    PATH: az.path,
    ...files.env,
    ...ado.env,
    ABE_ORG_STORE: pathToFileURL(store).href,
  };
  const abe = cli({ env, cwd: files.repo });
  const teammate = cli({ env, cwd: files.repo });

  return {
    ado,
    abe,
    teammate,
    store,
    close: async () => {
      await abe.close();
      await teammate.close();
      await ado.stop();
      az.remove();
      files.remove();
      rmSync(store, { recursive: true, force: true });
    },
  };
};

describe('abe sheet', () => {
  let w: Awaited<ReturnType<typeof world>>;
  let abe: Cli;
  let ado: FakeAdo;
  let watch: Streaming;
  let cart: string;

  // the page by its full path: commands are typed in the board's checkout
  const save = (file: string, title: string, ...more: string[]) =>
    abe.json(
      SheetSaveData,
      'sheet',
      'save',
      '--title',
      title,
      '--file',
      join(abe.state.dir, file),
      ...more,
    );

  beforeAll(async () => {
    w = await world();
    ({ abe, ado } = w);
    writeFileSync(join(abe.state.dir, 'cart.html'), PAGE);
    writeFileSync(join(abe.state.dir, 'reaching.html'), REACHING);
    await abe.run('status');
    watch = abe.spawn('watch', '--json');
    await Bun.sleep(100);
  });
  afterAll(async () => {
    watch.signal('SIGKILL');
    await w.close();
  });

  test('save: a new Sheet at v1, kept in serve’s state directory as yours', async () => {
    const { exit, doc } = await save('cart.html', 'Cart totals', '--card', 'AB#4');
    const saved = ok(doc);

    expect(exit).toBe(0);
    expect(saved).toMatchObject({ title: 'Cart totals', version: 1, card: 4, session: null });
    expect(saved.id).toMatch(/^cart-totals-[0-9a-f]{6}$/);
    expect(saved.path).toBe(join(abe.state.dir, 'sheets', saved.id, 'v1.html'));
    expect(saved.address).toBe(`sheet://${saved.id}`);
    expect(readFileSync(saved.path, 'utf8')).toBe(PAGE);
    cart = saved.id;
  });

  test('save under the same title: the next version of the same Sheet', async () => {
    writeFileSync(join(abe.state.dir, 'cart2.html'), PAGE.replace('12', '13'));
    const saved = ok((await save('cart2.html', 'cart totals')).doc);

    expect(saved).toMatchObject({ id: cart, version: 2, title: 'Cart totals', card: 4 });
  });

  test('a page reaching outside itself is refused, naming each reach; nothing is saved', async () => {
    const { exit, doc } = await save('reaching.html', 'Remote rows');

    expect(exit).toBe(1);
    expect(doc).toMatchObject({ ok: false, error: { code: 'sheet-not-self-contained' } });
    if (doc.ok) return;
    expect(doc.error.message).toContain('href https://cdn.test/a.css (line 2)');
    expect(doc.error.message).toContain('src https://img.test/logo.png (line 3)');
    expect(doc.error.message).toContain('fetch https://api.test/rows (line 4)');
    const list = ok((await abe.json(SheetListData, 'sheet', 'list')).doc);

    expect(list.sheets.map((s) => s.title)).not.toContain('Remote rows');
  });

  test('a bad title or a missing file is refused', async () => {
    const bad = await save('cart.html', '  ');
    const missing = await save('none.html', 'Nothing');

    expect(bad.exit).toBe(2);
    expect(bad.doc).toMatchObject({ ok: false, error: { code: 'usage' } });
    expect(missing.doc).toMatchObject({ ok: false, error: { code: 'unreadable-file' } });
  });

  test('show --json: path, title, card, versions, attached; --version picks one', async () => {
    const newest = ok((await abe.json(SheetShowData, 'sheet', 'show', cart)).doc);
    const first = ok(
      (await abe.json(SheetShowData, 'sheet', 'show', 'Cart totals', '--version', '1')).doc,
    );
    const none = await abe.json(SheetShowData, 'sheet', 'show', cart, '--version', '9');

    expect(newest).toMatchObject({
      id: cart,
      title: 'Cart totals',
      card: 4,
      version: 2,
      attached: [],
    });
    expect(newest.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(newest.path).toBe(join(abe.state.dir, 'sheets', cart, 'v2.html'));
    expect(first.path).toBe(join(abe.state.dir, 'sheets', cart, 'v1.html'));
    expect(none.doc).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  test('list and find: the current card’s and session’s first', async () => {
    writeFileSync(join(abe.state.dir, 'carrier.html'), PAGE);
    const carrier = ok((await save('carrier.html', 'Carrier rates', '--session', 's1')).doc);
    const list = ok((await abe.json(SheetListData, 'sheet', 'list', '--card', '4')).doc);
    const bySession = ok(
      (await abe.json(SheetFindData, 'sheet', 'find', 'car', '--session', 's1')).doc,
    );
    const byCard = ok((await abe.json(SheetFindData, 'sheet', 'find', 'car', '--card', '4')).doc);
    const none = ok((await abe.json(SheetFindData, 'sheet', 'find', 'invoice')).doc);

    expect(list.sheets.map((s) => s.id)).toEqual([cart, carrier.id]);
    expect(bySession.sheets.map((s) => s.id)).toEqual([carrier.id, cart]);
    expect(byCard.sheets.map((s) => s.id)).toEqual([cart, carrier.id]);
    expect(none.sheets).toEqual([]);
    expect((await abe.run('sheet', 'find', 'invoice')).stdout).toBe('no Sheet matches invoice\n');
  });

  test('open --json: a local URL serving the page under the no-network policy, nothing else', async () => {
    const { exit, doc } = await abe.json(SheetOpenData, 'sheet', 'open', cart);
    const opened = ok(doc);

    expect(exit).toBe(0);
    expect(opened).toMatchObject({ id: cart, version: 2, card: null, csp: SHEET_CSP });
    expect(opened.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    const page = await fetch(opened.url);

    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toBe(
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    );
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page.text()).toBe(PAGE.replace('12', '13'));
    const origin = new URL(opened.url).origin;

    for (const other of [
      '/',
      '/x',
      `${new URL(opened.url).pathname}/x`,
      `${new URL(opened.url).pathname}?a=1`,
    ]) {
      const res = await fetch(`${origin}${other}`);

      expect(res.status).toBe(404);
      expect(await res.text()).toBe('');
    }
    expect((await fetch(opened.url, { method: 'POST' })).status).toBe(404);
    const again = ok((await abe.json(SheetOpenData, 'sheet', 'open', cart)).doc);
    const v1 = ok((await abe.json(SheetOpenData, 'sheet', 'open', cart, '--version', '1')).doc);

    expect(again.url).toBe(opened.url);
    expect(new URL(v1.url).origin).not.toBe(origin);
  });

  // Abe writes no comment on the card (Azure Boards' comments are the person's): none is posted.
  const commentPosts = () => ado.requests().filter((r) => /^POST .*\/comments/.test(r)).length;

  test('attach: the page to the org store under the card, the card lists it, no comment on it', async () => {
    const before = ok((await abe.json(CardShowData, 'card', 'show', '4')).doc);
    const { exit, doc } = await abe.json(SheetAttachData, 'sheet', 'attach', cart, '--card', '4');
    const attached = ok(doc);
    const key = `sheets/4/${cart}/v2.html`;

    expect(exit).toBe(0);
    expect(attached).toEqual({
      id: cart,
      title: 'Cart totals',
      version: 2,
      card: 4,
      key,
      address: `sheet://4/${cart}`,
    });
    expect(readFileSync(join(w.store, ...key.split('/')), 'utf8')).toBe(PAGE.replace('12', '13'));
    const after = ok((await abe.json(CardShowData, 'card', 'show', '4')).doc);

    expect(after.comments).toEqual(before.comments);
    expect(commentPosts()).toBe(0);
    expect(after.sheets).toMatchObject([
      { id: cart, title: 'Cart totals', version: 2, address: `sheet://4/${cart}` },
    ]);
    expect((await abe.run('card', 'show', '4')).stdout).toContain(
      `\nSheets:\n  Cart totals v2  sheet://4/${cart}\n`,
    );
    const shown = ok((await abe.json(SheetShowData, 'sheet', 'show', cart)).doc);

    expect(shown.attached).toMatchObject([{ card: 4, version: 2, key }]);
  });

  test('attach again: listed once, still no comment', async () => {
    const again = ok((await abe.json(SheetAttachData, 'sheet', 'attach', cart, '--card', '4')).doc);
    const card = ok((await abe.json(CardShowData, 'card', 'show', '4')).doc);

    expect(again).toMatchObject({ card: 4, version: 2 });
    expect(commentPosts()).toBe(0);
    expect(card.sheets.map((x) => x.id)).toEqual([cart]);
  });

  test('two attaches at once: listed once, no comment', async () => {
    const [a, b] = await Promise.all([
      abe.json(SheetAttachData, 'sheet', 'attach', cart, '--card', '5'),
      abe.json(SheetAttachData, 'sheet', 'attach', cart, '--card', '5'),
    ]);
    const card = ok((await abe.json(CardShowData, 'card', 'show', '5')).doc);

    expect([ok(a.doc).card, ok(b.doc).card]).toEqual([5, 5]);
    expect(card.sheets.map((x) => x.id)).toEqual([cart]);
    expect(commentPosts()).toBe(0);
  });

  test('a teammate opens the attached Sheet from the org store; theirs does not include yours', async () => {
    const theirs = ok((await w.teammate.json(SheetListData, 'sheet', 'list')).doc);
    const mine = await w.teammate.json(SheetOpenData, 'sheet', 'open', cart);
    const opened = ok(
      (await w.teammate.json(SheetOpenData, 'sheet', 'open', `sheet://4/${cart}`)).doc,
    );
    const page = await fetch(opened.url);

    expect(theirs.sheets).toEqual([]);
    expect(mine.doc).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(opened).toMatchObject({ id: cart, card: 4, version: 2, title: 'Cart totals' });
    expect(page.headers.get('content-security-policy')).toBe(SHEET_CSP);
    expect(await page.text()).toBe(PAGE.replace('12', '13'));
  });

  test('attach to a card that is not there: refused, nothing uploaded', async () => {
    const { doc } = await abe.json(SheetAttachData, 'sheet', 'attach', cart, '--card', '999');

    expect(doc).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(existsSync(join(w.store, 'sheets', '999'))).toBe(false);
  });

  test('sheet.saved and sheet.attached events', async () => {
    const seen: Event[] = [];

    while (seen.filter((e) => e.type === 'sheet.attached' && e.data.card === 5).length < 2) {
      const line = await watch.next();
      const event = Event.parse(JSON.parse(line));

      if (event.type === 'sheet.saved' || event.type === 'sheet.attached') seen.push(event);
    }
    expect(seen.map((e) => [e.type, e.data])).toMatchObject([
      ['sheet.saved', { id: cart, title: 'Cart totals', version: 1, card: 4, session: null }],
      ['sheet.saved', { id: cart, title: 'Cart totals', version: 2, card: 4, session: null }],
      ['sheet.saved', { title: 'Carrier rates', version: 1, card: null, session: 's1' }],
      [
        'sheet.attached',
        {
          id: cart,
          title: 'Cart totals',
          version: 2,
          card: 4,
          key: `sheets/4/${cart}/v2.html`,
        },
      ],
      [
        'sheet.attached',
        {
          id: cart,
          title: 'Cart totals',
          version: 2,
          card: 4,
          key: `sheets/4/${cart}/v2.html`,
        },
      ],

      ['sheet.attached', { card: 5 }],
      ['sheet.attached', { card: 5 }],
    ]);
  });
});

describe('without an org store', () => {
  test('attach is refused, saying how to name one', async () => {
    const abe = cli();

    try {
      writeFileSync(join(abe.state.dir, 'p.html'), PAGE);
      const saved = ok(
        (await abe.json(SheetSaveData, 'sheet', 'save', '--title', 'P', '--file', 'p.html')).doc,
      );
      const { exit, doc } = await abe.json(
        SheetAttachData,
        'sheet',
        'attach',
        saved.id,
        '--card',
        '4',
      );

      expect(exit).toBe(1);
      expect(doc).toMatchObject({ ok: false, error: { code: 'no-org-store' } });
      if (!doc.ok) expect(doc.error.message).toContain('ABE_ORG_STORE');
    } finally {
      await abe.close();
    }
  });
});
