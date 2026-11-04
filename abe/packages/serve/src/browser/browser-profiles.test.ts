/**
 * `abe browser list|add|rename|remove|default` (#103 S2) on an in-process `serve` (`served`) on
 * temporary settings (a checkout's `abe.yaml`, yours on this Mac) and a Chrome folder
 * like 1.0's.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserListData,
  BrowserOpenData,
  BrowserStoreData,
  BrowserWriteData,
  readEnvelope,
  type Reply,
  StorageState,
} from '@abe/core';
import {
  fakeChrome,
  type FakeChrome,
  fakeProfileStore,
  type FakeProfileStore,
  cli,
  scenario,
  served,
  type ServedCli,
  type ServeScenario,
  tempState,
} from '@abe/testing';
import { type z } from 'zod';

type Setup = { root: string; mine: string; repo: string; abe: ServedCli };

const open: Setup[] = [];

/** `repo`: the checkout's `abe.yaml`, where commands are typed; `mine`: yours on this Mac. */
const setup = async (
  o: { repo?: string; mine?: string; chromes?: string[] } = {},
): Promise<Setup> => {
  const root = mkdtempSync(join(tmpdir(), 'abe-profiles-'));
  const mine = join(root, 'mine');
  const repo = join(root, 'demo');

  mkdirSync(join(repo, '.abe'), { recursive: true });
  mkdirSync(mine, { recursive: true });
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'abe.yaml'), o.repo ?? '');
  // yours for the repo, never committed
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
  writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
  writeFileSync(join(mine, 'settings.yaml'), o.mine ?? '');
  for (const c of o.chromes ?? [])
    mkdirSync(join(mine, 'chrome', c, 'Default'), { recursive: true });
  const abe = await served({ cwd: repo, env: { ABE_CONFIG_DIR: mine } });
  const s = { root, mine, repo, abe };

  open.push(s);

  return s;
};

afterEach(async () => {
  for (const s of open.splice(0)) {
    await s.abe.close();
    rmSync(s.root, { recursive: true, force: true });
  }
});

const names = (d: BrowserListData) =>
  d.profiles.map((p) => `${p.name}:${p.layer}${p.default ? '*' : ''}`);

describe('abe browser list', () => {
  // the CLI contract: exit 0 and the --json document through the real `abe`
  test('no browser settings anywhere: only the built-in default', async () => {
    const abe = cli();

    try {
      const r = await abe.json(BrowserListData, 'browser', 'list');

      expect(r.exit).toBe(0);
      expect(r.doc.ok && names(r.doc.data)).toEqual(['default:built-in*']);
    } finally {
      await abe.close();
    }
  });

  test("the repo's first, then yours; a repo profile is not renamed or removed", async () => {
    const { abe } = await setup({
      repo: 'browser:\n  profiles:\n    - { name: work, purpose: app user }\n',
      mine: 'browser:\n  profiles:\n    - { name: po-review, purpose: "product owner\'s login" }\n',
    });
    const r = await abe.json(BrowserListData, 'browser', 'list');

    expect(r.doc.ok && names(r.doc.data)).toEqual([
      'work:repo',
      'po-review:individual',
      'default:built-in*',
    ]);
    for (const argv of [
      ['rename', 'work', 'x'],
      ['remove', 'work'],
    ]) {
      const refused = await abe.json(BrowserWriteData, 'browser', ...argv);

      expect(refused.doc).toMatchObject({ ok: false, error: { code: 'team-profile' } });
    }
  });
});

describe("1.0's two Chromes", () => {
  test('the first list renames them, leaves links and writes your Layer; a second changes nothing', async () => {
    const { abe, mine } = await setup({ chromes: ['acme', 'acme-admin'] });
    const first = await abe.json(BrowserListData, 'browser', 'list');

    expect(first.doc.ok && first.doc.data.migrated).toEqual([
      { from: 'acme', to: 'work' },
      { from: 'acme-admin', to: 'work-admin' },
    ]);
    expect(first.doc.ok && names(first.doc.data)).toEqual([
      'work:individual*',
      'work-admin:individual',
      'default:built-in',
    ]);
    expect(lstatSync(join(mine, 'chrome', 'acme')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(mine, 'chrome', 'acme'))).toBe('work');
    expect(existsSync(join(mine, 'chrome', 'acme', 'Default'))).toBe(true);
    const layer = readFileSync(join(mine, 'settings.yaml'), 'utf8');

    const second = await abe.json(BrowserListData, 'browser', 'list');

    expect(second.doc.ok && second.doc.data.migrated).toEqual([]);
    expect(readFileSync(join(mine, 'settings.yaml'), 'utf8')).toBe(layer);
  });

  test('another layout renames nothing and lists the folders not in a Layer', async () => {
    const { abe } = await setup({ chromes: ['acme', 'other'] });
    const r = await abe.json(BrowserListData, 'browser', 'list');

    expect(r.doc.ok && r.doc.data.migrated).toEqual([]);
    expect(r.doc.ok && r.doc.data.unlisted).toEqual(['acme', 'other']);
  });
});

describe('your profiles', () => {
  test('add, default, rename (the folder moves), remove', async () => {
    const { abe, mine } = await setup({ chromes: ['po'] });

    expect(
      (await abe.json(BrowserWriteData, 'browser', 'add', 'po', '--purpose', 'product owner')).doc,
    ).toMatchObject({ ok: true });
    expect((await abe.json(BrowserWriteData, 'browser', 'default', 'po')).doc).toMatchObject({
      ok: true,
    });
    const renamed = await abe.json(BrowserWriteData, 'browser', 'rename', 'po', 'po-review');

    expect(renamed.doc.ok && names(renamed.doc.data.list)).toEqual([
      'po-review:individual*',
      'default:built-in',
    ]);
    expect(existsSync(join(mine, 'chrome', 'po-review', 'Default'))).toBe(true);
    const removed = await abe.json(BrowserWriteData, 'browser', 'remove', 'po-review');

    expect(removed.doc.ok && names(removed.doc.data.list)).toEqual(['default:built-in*']);
    expect(removed.doc.ok && removed.doc.data.list.unlisted).toEqual(['po-review']);
  });

  test('a bad name, a taken name and an unknown default are refused', async () => {
    const { abe } = await setup({
      repo: 'browser:\n  profiles:\n    - { name: work, purpose: app user }\n',
    });

    expect(
      (await abe.json(BrowserWriteData, 'browser', 'add', 'Work', '--purpose', 'x')).doc,
    ).toMatchObject({
      ok: false,
      error: { code: 'bad-profile-name' },
    });
    expect(
      (await abe.json(BrowserWriteData, 'browser', 'add', 'work', '--purpose', 'x')).doc,
    ).toMatchObject({
      ok: false,
      error: { code: 'profile-exists' },
    });
    expect((await abe.json(BrowserWriteData, 'browser', 'default', 'nope')).doc).toMatchObject({
      ok: false,
      error: { code: 'no-profile' },
    });
  });
});

/**
 * `abe browser open|store` (#103 S3) on the Mac's `serve`: a fake Chrome on the profile's folder
 * (what DevTools would read there) and a fake store of your sign-ins.
 */
describe('signing in and storing it', () => {
  const PROFILES =
    'browser:\n  profiles:\n    - { name: work, purpose: app user }\n    - { name: po, purpose: product owner }\n';
  const SIGN_INS = {
    cookies: [
      {
        name: 'sid',
        value: 'cookie-value-never-printed',
        domain: '.app.example.test',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        session: true,
        size: 30,
      },
    ],
    origins: [
      {
        origin: 'https://app.example.test',
        localStorage: [{ name: 'token', value: 'storage-value-never-printed' }],
      },
    ],
  };

  type Mac = AsyncDisposable & {
    s: ServeScenario;
    chrome: FakeChrome;
    store: FakeProfileStore;
    config: string;
  };

  const mac = async (o: { box?: true; noStore?: true; watchMs?: number } = {}): Promise<Mac> => {
    const state = tempState();
    const config = join(state.dir, '.config', 'abe');

    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'settings.yaml'), PROFILES);
    const chrome = fakeChrome();
    const store = fakeProfileStore('ada', () => '2026-10-25T03:00:00.000Z');
    const s = await scenario({
      state,
      ...(o.box === undefined ? {} : { box: o.box }),
      // the watch reads only where a test asks for it
      browserProfiles: { ...(o.noStore ? {} : { store }), chrome, watchMs: o.watchMs ?? 3_600_000 },
    });

    return { s, chrome, store, config, [Symbol.asyncDispose]: () => s.close() };
  };

  const doc = <T extends z.ZodType>(schema: T, reply: Reply) =>
    readEnvelope(schema, JSON.parse(reply.stdout));

  test("open: the profile's Chrome on its own folder, a tab per URL", async () => {
    await using m = await mac();
    const { s, chrome, config } = m;
    const opened = doc(
      BrowserOpenData,
      await s.request('browser', 'open', 'work', 'https://app.example.test/login', '--json'),
    );

    expect(opened).toMatchObject({ ok: true, data: { name: 'work', started: true } });
    expect(chrome.opened).toEqual([
      { dir: join(config, 'chrome', 'work'), urls: ['https://app.example.test/login'] },
    ]);
    expect((await s.request('browser', 'open', 'work', 'javascript:x', '--json')).exit).toBe(2);
    expect(
      doc(BrowserOpenData, await s.request('browser', 'open', 'nope', '--json')),
    ).toMatchObject({
      ok: false,
      error: { code: 'no-profile' },
    });
  });

  test('store with no Chrome open on the folder: refused, naming abe browser open', async () => {
    await using m = await mac();
    const { s, store } = m;
    const r = doc(BrowserStoreData, await s.request('browser', 'store', 'work', '--json'));

    expect(r.ok ? '' : `${r.error.code}: ${r.error.message}`).toBe(
      "chrome-not-running: work's Chrome is not open: abe browser open work, sign in, then store again",
    );
    expect(store.writes).toEqual([]);
  });

  test('store: the open Chrome read, one write of the state, no value in the answer', async () => {
    await using m = await mac();
    const { s, chrome, store, config } = m;
    await s.request('browser', 'open', 'work', '--json');
    chrome.signIns.set(join(config, 'chrome', 'work'), SIGN_INS);
    const reply = await s.request('browser', 'store', 'work', '--json');
    const r = doc(BrowserStoreData, reply);

    expect(r).toMatchObject({
      ok: true,
      data: {
        name: 'work',
        secret: 'abe/ada/browser/work',
        cookies: 1,
        origins: ['https://app.example.test'],
      },
    });
    expect(reply.stdout).not.toContain('never-printed');
    expect((await s.request('browser', 'store', 'work')).stdout).not.toContain('never-printed');
    expect(store.writes.map((w) => w.name)).toEqual(['work', 'work']);
    const written = StorageState.parse(JSON.parse(store.writes[0]?.text ?? ''));

    expect(written).toEqual({ v: 1, storedAt: written.storedAt, ...SIGN_INS });
    // The list names when it was stored.
    const list = doc(BrowserListData, await s.request('browser', 'list', '--json'));

    expect(list.ok && list.data.profiles.map((p) => [p.name, p.storedAt])).toEqual([
      ['work', '2026-10-25T03:00:00.000Z'],
      ['po', null],
      ['default', null],
    ]);
  });

  test('too large for a secret: refused naming the biggest origin, nothing written', async () => {
    await using m = await mac();
    const { s, chrome, store, config } = m;
    await s.request('browser', 'open', 'work', '--json');
    chrome.signIns.set(join(config, 'chrome', 'work'), {
      cookies: [],
      origins: [
        {
          origin: 'https://big.example.test',
          localStorage: [{ name: 'cache', value: 'x'.repeat(70_000) }],
        },
      ],
    });
    const r = doc(BrowserStoreData, await s.request('browser', 'store', 'work', '--json'));

    expect(r.ok ? '' : r.error.code).toBe('profile-too-large');
    expect(r.ok ? '' : r.error.message).toContain('local storage of https://big.example.test');
    expect(store.writes).toEqual([]);
  });

  test('the built-in default has nothing to sign in to; a box never opens or stores', async () => {
    await using m = await mac();
    const { s } = m;
    expect(
      doc(BrowserStoreData, await s.request('browser', 'store', 'default', '--json')),
    ).toMatchObject({
      ok: false,
      error: { code: 'bad-profile-name' },
    });
    await using box = await mac({ box: true });

    expect(
      doc(BrowserOpenData, await box.s.request('browser', 'open', 'work', '--json')),
    ).toMatchObject({
      ok: false,
      error: { code: 'mac-only' },
    });
  });

  test('rename moves the stored sign-ins; remove --forget deletes them', async () => {
    await using m = await mac();
    const { s, store } = m;
    store.stored.set('po', { text: '{"v":1}', storedAt: '2026-10-24T03:00:00.000Z' });
    await s.request('browser', 'rename', 'po', 'po-review', '--json');
    expect([...store.stored.keys()]).toEqual(['po-review']);
    expect(store.stored.get('po-review')?.text).toBe('{"v":1}');
    await s.request('browser', 'remove', 'po-review', '--forget', '--json');
    expect(store.removed).toEqual(['po', 'po-review']);
    expect(store.stored.size).toBe(0);
  });

  /** Waits until `ok()` holds, polling; fails after 2 s. */
  const until = async (what: string, ok: () => boolean) => {
    for (let i = 0; i < 400; i += 1) {
      if (ok()) return;
      await Bun.sleep(5);
    }
    throw new Error(`timed out: ${what}`);
  };
  const cookie = (name: string, value: string) => ({
    name,
    value,
    domain: '.app.example.test',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
  });
  const listed = async (m: Mac) => {
    const r = doc(BrowserListData, await m.s.request('browser', 'list', '--json'));

    return r.ok ? r.data.profiles.find((p) => p.name === 'work') : undefined;
  };
  const stored = (m: Mac) =>
    m.store.writes.map((w) => StorageState.parse(JSON.parse(w.text)).cookies.map((c) => c.value));

  /**
   * Settings' Open (`browser open --front`) and what follows while that Chrome runs: read while
   * open, stored on its own on a sign-in and on its close, its folder never touched.
   */
  test.each<{
    name: string;
    o?: { noStore?: true };
    run: (m: Mac, dir: string) => Promise<void>;
  }>([
    {
      name: 'Open: a closed Chrome starts in front; an open one is brought to the front, never a second',
      run: async (m, dir) => {
        const first = doc(
          BrowserOpenData,
          await m.s.request('browser', 'open', 'work', '--front', '--json'),
        );

        expect(first).toMatchObject({ ok: true, data: { started: true, fronted: false } });
        const again = doc(
          BrowserOpenData,
          await m.s.request('browser', 'open', 'work', '--front', '--json'),
        );

        expect(again).toMatchObject({ ok: true, data: { started: false, fronted: true } });
        expect(m.chrome.opened).toEqual([{ dir, urls: [], front: true }]);
        expect(m.chrome.fronted).toEqual([dir]);
        // the CLI as before: no --front, the running one gets a new window
        await m.s.request('browser', 'open', 'work', '--json');
        expect(m.chrome.opened.at(-1)).toEqual({ dir, urls: [] });
        expect(await listed(m)).toMatchObject({ open: true, storedAt: null });
      },
    },
    {
      name: 'its close stores the cookies as last read, once; never a tab opened to read it',
      run: async (m, dir) => {
        m.chrome.signIns.set(dir, SIGN_INS);
        await m.s.request('browser', 'open', 'work', '--front', '--json');
        await until('the first reading', () => m.chrome.cookieReads >= 1);
        // a token rotated in the same cookie: read, not stored while open
        m.chrome.signIns.set(dir, { ...SIGN_INS, cookies: [cookie('sid', 'rotated')] });
        await Bun.sleep(40);
        expect(m.store.writes).toEqual([]);
        m.chrome.runningOn.delete(dir);
        await until('stored on close', () => m.store.writes.length === 1);
        expect(stored(m)).toEqual([['rotated']]);
        // local storage takes a tab per origin: only abe browser store reads it
        expect(StorageState.parse(JSON.parse(m.store.writes[0]?.text ?? '')).origins).toEqual([]);
        expect(await listed(m)).toMatchObject({
          open: false,
          storedAt: '2026-10-25T03:00:00.000Z',
          storeFailed: null,
        });
        expect(m.chrome.fullReads).toBe(0);
        expect(existsSync(join(dir, 'Default'))).toBe(true);
      },
    },
    {
      name: 'a sign-in while open (a new cookie, held still) is stored at once, cookies alone',
      run: async (m, dir) => {
        await m.s.request('browser', 'open', 'work', '--front', '--json');
        await until('the first reading', () => m.chrome.cookieReads >= 1);
        m.chrome.signIns.set(dir, SIGN_INS);
        await until('stored while open', () => m.store.writes.length === 1);
        expect(m.chrome.fullReads).toBe(0);
        expect(stored(m)).toEqual([['cookie-value-never-printed']]);
        // nothing new on close: the same is not written again
        m.chrome.runningOn.delete(dir);
        await until('closed', () => m.chrome.runningOn.size === 0);
        await Bun.sleep(40);
        expect(m.store.writes).toHaveLength(1);
      },
    },
    {
      name: 'a failed store is said on its row; the folder keeps everything',
      run: async (m, dir) => {
        m.store.write = () =>
          Promise.resolve({
            ok: false,
            error: { code: 'profile-unwritable', message: 'abe/ada/browser/work: ExpiredToken' },
          });
        m.chrome.signIns.set(dir, SIGN_INS);
        await m.s.request('browser', 'open', 'work', '--front', '--json');
        await until('the first reading', () => m.chrome.cookieReads >= 1);
        m.chrome.runningOn.delete(dir);
        await until('closed', () => m.chrome.runningOn.size === 0);
        await Bun.sleep(40);
        expect(await listed(m)).toMatchObject({
          open: false,
          storedAt: null,
          storeFailed: 'abe/ada/browser/work: ExpiredToken',
        });
        expect(existsSync(join(dir, 'Default'))).toBe(true);
      },
    },
    {
      name: 'no store set up: never read, nothing stored, nothing said',
      o: { noStore: true },
      run: async (m, dir) => {
        m.chrome.signIns.set(dir, SIGN_INS);
        await m.s.request('browser', 'open', 'work', '--front', '--json');
        await Bun.sleep(40);
        m.chrome.runningOn.delete(dir);
        await Bun.sleep(40);
        expect(m.chrome.fullReads + m.chrome.cookieReads).toBe(0);
        expect(await listed(m)).toMatchObject({ open: false, storeFailed: null });
        expect(existsSync(join(dir, 'Default'))).toBe(true);
      },
    },
  ])('$name', async ({ o, run }) => {
    await using m = await mac({ ...o, watchMs: 5 });
    const dir = join(m.config, 'chrome', 'work');

    // the folder as a sign-in left it
    mkdirSync(join(dir, 'Default'), { recursive: true });
    // serve read before anything was open: its later readings still run
    await Bun.sleep(20);
    await run(m, dir);
  });
});
