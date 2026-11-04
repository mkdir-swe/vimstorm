/**
 * The org store `$ABE_ORG_STORE` names (#82): the S3 bucket through a fake `aws`, the folder, and
 * with `ABE_TEST_S3_ORG_STORE=s3://<bucket>/<prefix>` (and that AWS in the environment) the real
 * bucket, each through the same round trip a Make card upload and a Show prototype read make.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type OrgStore } from '@abe/core';
import { fakeS3, type FakeS3 } from '@abe/testing';
import { awsEnv } from './aws';
import { orgStoreFrom } from './org-store';

const bytes = (text: string) => new TextEncoder().encode(text);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 7]);

/** What Make card writes and Show prototype reads, on any store. */
const roundTrip = (
  name: string,
  open: () => { store: OrgStore; close: () => Promise<void> },
  skip = false,
) => {
  describe.skipIf(skip)(name, () => {
    let store: OrgStore;
    let close: () => Promise<void>;

    beforeAll(() => {
      ({ store, close } = open());
    });
    afterAll(async () => {
      await close();
    });

    test('a version’s files go in whole, bytes as bytes, and are listed and read back by key', async () => {
      const base = 'prototypes/shop/4/v1/';

      expect(await store.put(`${base}changes/1.css`, bytes('h1{}'), 'text/css')).toEqual({
        ok: true,
        data: { key: `${base}changes/1.css`, size: 4 },
      });
      expect((await store.put(`${base}screenshots/1.png`, PNG, 'image/png')).ok).toBe(true);
      expect((await store.put(`${base}meta.json`, bytes('{}'), 'application/json')).ok).toBe(true);
      expect(await store.list(base)).toEqual({
        ok: true,
        data: [
          { key: `${base}changes/1.css`, size: 4 },
          { key: `${base}meta.json`, size: 2 },
          { key: `${base}screenshots/1.png`, size: PNG.length },
        ],
      });
      expect(await store.get(`${base}screenshots/1.png`)).toEqual({ ok: true, data: PNG });
      expect(await store.list('prototypes/shop/5/')).toEqual({ ok: true, data: [] });
    });

    test('a key it does not hold is not-found; a key it cannot hold is bad-key', async () => {
      const missing = await store.get('prototypes/shop/9/prototype.json');

      expect(missing.ok ? 'ok' : missing.error.code).toBe('not-found');
      const bad = await store.put('prototypes/../x', bytes(''), 'text/plain');

      expect(bad.ok ? 'ok' : bad.error.code).toBe('bad-key');
    });
  });
};

roundTrip('S3 through a fake aws', () => {
  const s3 = fakeS3();
  const store = orgStoreFrom({ PATH: s3.path, ABE_ORG_STORE: 's3://abe-org-store-test/t82' });

  if (store === undefined) throw new Error('no store');

  return {
    store,
    close: () => {
      s3.remove();

      return Promise.resolve();
    },
  };
});

roundTrip('the folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'org-'));
  const store = orgStoreFrom({ ABE_ORG_STORE: `file://${dir}` });

  if (store === undefined) throw new Error('no store');

  return {
    store,
    close: () => {
      rmSync(dir, { recursive: true, force: true });

      return Promise.resolve();
    },
  };
});

const REAL = process.env.ABE_TEST_S3_ORG_STORE ?? '';

roundTrip(
  `the real bucket (${REAL === '' ? 'ABE_TEST_S3_ORG_STORE not set' : REAL})`,
  () => {
    const run = `${REAL.replace(/\/+$/, '')}/run-${Date.now()}-${process.pid}`;
    const store = orgStoreFrom({ ...process.env, ABE_ORG_STORE: run });

    if (store === undefined) throw new Error(`no store for ${run}`);

    return {
      store,
      close: async () => {
        const rm = Bun.spawn(['aws', 's3', 'rm', run, '--recursive', '--only-show-errors'], {
          env: awsEnv(process.env),
          stdout: 'inherit',
          stderr: 'inherit',
        });

        if ((await rm.exited) !== 0) throw new Error(`aws s3 rm ${run} failed`);
      },
    };
  },
  REAL === '',
);

describe('$ABE_ORG_STORE', () => {
  let s3: FakeS3;

  beforeAll(() => {
    s3 = fakeS3();
  });
  afterAll(() => {
    s3.remove();
  });

  test('names none: no org store', () => {
    expect(orgStoreFrom({})).toBeUndefined();
    expect(orgStoreFrom({ ABE_ORG_STORE: '' })).toBeUndefined();
  });

  test('a refusal names the org store and the key, with AWS’s words', async () => {
    s3.deny(['prototypes/']);
    const store = orgStoreFrom({ PATH: s3.path, ABE_ORG_STORE: 's3://abe-org-store-test' });
    const put = await store?.put('prototypes/shop/4/v1/meta.json', bytes('{}'), 'application/json');

    expect(put).toMatchObject({ ok: false, error: { code: 'store-failed' } });
    expect(put?.ok === false && put.error.message).toContain('(AccessDenied)');
    expect(put?.ok === false && put.error.message).toContain(
      's3://abe-org-store-test/prototypes/shop/4/v1/meta.json',
    );
  });

  test('a bad s3:// or another kind is refused at every call', async () => {
    for (const [named, message] of [
      ['s3://Not_A_Bucket', 'ABE_ORG_STORE s3://Not_A_Bucket: not an S3 bucket name: Not_A_Bucket'],
      ['gs://x', 'ABE_ORG_STORE gs://x: an org store is file://<dir> or s3://<bucket>[/<prefix>]'],
    ] as const) {
      const store = orgStoreFrom({ PATH: s3.path, ABE_ORG_STORE: named });

      expect(await store?.list('')).toEqual({
        ok: false,
        error: { code: 'bad-org-store', message },
      });
    }
  });
});
