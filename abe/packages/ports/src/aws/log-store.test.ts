/**
 * The log store's contract, run against each implementation: the folder (`file://`), S3 through a
 * fake `aws` over a folder, and, with `ABE_TEST_S3_LOG_STORE=s3://<bucket>/<prefix>` set, the real
 * bucket under that prefix (a run of its own, removed after) on the caller's AWS credentials: a
 * developer's SSO profile, which may write and delete anywhere (a box role may write only under its
 * own login, so the contract's `demo/octocat/…` would be refused there).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LogStore } from '@abe/core';
import { fakeS3, type FakeS3 } from '@abe/testing';
import { awsEnv, awsRunner } from './aws';
import { fileLogStore, logStoreFrom } from './log-store';
import { s3LogStore } from './s3-store';

type Opened = { store: LogStore; close: () => Promise<void> };

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const JSONL = 'application/x-ndjson';

const contract = (name: string, open: () => Promise<Opened>, skip = false) => {
  describe.skipIf(skip)(`${name}: the log store contract`, () => {
    let o: Opened;
    let store: LogStore;

    beforeAll(async () => {
      o = await open();
      store = o.store;
    });
    afterAll(async () => {
      await o.close();
    });

    test('put then get: the same bytes, its key and size', async () => {
      // Not UTF-8: the store keeps bytes, not text.
      const body = new Uint8Array([0x7b, 0x0a, 0xff, 0x00, 0xfe, 0x7d]);

      expect(await store.put('demo/ada/1-a1/hooks.jsonl', body, JSONL)).toEqual({
        ok: true,
        data: { key: 'demo/ada/1-a1/hooks.jsonl', size: 6 },
      });
      expect(await store.get('demo/ada/1-a1/hooks.jsonl')).toEqual({ ok: true, data: body });
    });

    test('put again replaces the object whole', async () => {
      await store.put(
        'demo/ada/1-a1/meta.json',
        bytes('{"state":"working","long":true}'),
        'application/json',
      );
      await store.put('demo/ada/1-a1/meta.json', bytes('{"state":"ended"}'), 'application/json');
      const got = await store.get('demo/ada/1-a1/meta.json');

      expect(got.ok && text(got.data)).toBe('{"state":"ended"}');
    });

    test('get of a key it does not hold: not-found', async () => {
      const got = await store.get('demo/ada/9-none/meta.json');

      expect(got).toMatchObject({ ok: false, error: { code: 'not-found' } });
    });

    test('list: every object under the prefix, by key, with its size; nothing else', async () => {
      await store.put('demo/ada/2-b2/transcript.jsonl', bytes('{}\n{}\n'), JSONL);
      await store.put('demo/ada/2-b2/verify/report.md', bytes('# Verify\n'), 'text/markdown');
      await store.put('demo/octocat/3-c3/meta.json', bytes('{}'), 'application/json');
      await store.put('web/ada/4-d4/meta.json', bytes('{}'), 'application/json');

      expect(await store.list('demo/ada/2-b2/')).toEqual({
        ok: true,
        data: [
          { key: 'demo/ada/2-b2/transcript.jsonl', size: 6 },
          { key: 'demo/ada/2-b2/verify/report.md', size: 9 },
        ],
      });
      const team = await store.list('demo/');

      expect(team.ok && team.data.map((s) => s.key)).toEqual([
        'demo/ada/1-a1/hooks.jsonl',
        'demo/ada/1-a1/meta.json',
        'demo/ada/2-b2/transcript.jsonl',
        'demo/ada/2-b2/verify/report.md',
        'demo/octocat/3-c3/meta.json',
      ]);
      // A prefix is matched on its characters, not only whole parts.
      const partial = await store.list('demo/octo');

      expect(partial.ok && partial.data.map((s) => s.key)).toEqual(['demo/octocat/3-c3/meta.json']);
      const all = await store.list('');

      expect(all.ok && all.data.length).toBe(6);
    });

    test('list of a prefix nothing is under: none', async () => {
      expect(await store.list('api/')).toEqual({ ok: true, data: [] });
    });

    test('a key that is not one: bad-key, nothing written', async () => {
      for (const key of ['', 'demo//x', '../demo/x', 'demo/./x', 'demo/a b', 'demo/x?y'])
        expect(await store.put(key, bytes('x'), 'text/plain')).toMatchObject({
          ok: false,
          error: { code: 'bad-key' },
        });
      expect(await store.get('demo/../x')).toMatchObject({ ok: false, error: { code: 'bad-key' } });
      expect(await store.list('demo//')).toMatchObject({ ok: false, error: { code: 'bad-key' } });
      const all = await store.list('');

      expect(all.ok && all.data.length).toBe(6);
    });
  });
};

const temp = () => mkdtempSync(join(tmpdir(), 'abe-log-store-'));

contract('a folder', () => {
  const dir = temp();

  return Promise.resolve({
    store: fileLogStore(dir),
    close: () => {
      rmSync(dir, { recursive: true, force: true });
      return Promise.resolve();
    },
  });
});

contract('S3 through a fake aws', () => {
  const s3 = fakeS3();

  return Promise.resolve({
    store: s3LogStore({
      bucket: 'abe-logs-test',
      prefix: 'run-1',
      aws: awsRunner({ PATH: s3.path }),
    }),
    close: () => {
      s3.remove();
      return Promise.resolve();
    },
  });
});

const REAL = process.env.ABE_TEST_S3_LOG_STORE ?? '';

contract(
  `the real bucket (${REAL === '' ? 'ABE_TEST_S3_LOG_STORE not set' : REAL})`,
  () => {
    const run = `${REAL.replace(/\/+$/, '')}/run-${Date.now()}-${process.pid}`;
    const store = logStoreFrom({ ...process.env, ABE_LOG_STORE: run });

    if (store === undefined) throw new Error(`no store for ${run}`);

    return Promise.resolve({
      store,
      close: async () => {
        // What the run wrote goes; the bucket's 90 days would take it anyway.
        const rm = Bun.spawn(['aws', 's3', 'rm', run, '--recursive', '--only-show-errors'], {
          env: awsEnv(process.env),
          stdout: 'inherit',
          stderr: 'inherit',
        });

        if ((await rm.exited) !== 0) throw new Error(`aws s3 rm ${run} failed`);
      },
    });
  },
  REAL === '',
);

describe('S3 through the aws CLI', () => {
  let s3: FakeS3;

  beforeAll(() => {
    s3 = fakeS3();
  });
  afterAll(() => {
    s3.remove();
  });

  test('$ABE_LOG_STORE=s3://<bucket> is the bucket, on the caller’s own AWS', async () => {
    const store = logStoreFrom({ PATH: s3.path, ABE_LOG_STORE: 's3://abe-logs-test' });

    expect(await store?.put('demo/ada/5-e5/meta.json', bytes('{}'), 'application/json')).toEqual({
      ok: true,
      data: { key: 'demo/ada/5-e5/meta.json', size: 2 },
    });
    // The same bucket under a prefix sees none of it; the bucket's root does.
    const under = logStoreFrom({ PATH: s3.path, ABE_LOG_STORE: 's3://abe-logs-test/t58/' });

    expect(await under?.list('')).toEqual({ ok: true, data: [] });
    expect(await store?.list('demo/')).toEqual({
      ok: true,
      data: [{ key: 'demo/ada/5-e5/meta.json', size: 2 }],
    });
  });

  test('a put the bucket policy refuses: store-failed, saying AccessDenied', async () => {
    s3.deny(['demo/octocat/']);
    const store = logStoreFrom({ PATH: s3.path, ABE_LOG_STORE: 's3://abe-logs-test' });
    const put = await store?.put('demo/octocat/6-f6/meta.json', bytes('{}'), 'application/json');

    expect(put).toMatchObject({ ok: false, error: { code: 'store-failed' } });
    expect(put?.ok === false && put.error.message).toContain('(AccessDenied)');
    expect(put?.ok === false && put.error.message).toContain('demo/octocat/6-f6/meta.json');
  });

  test('no aws on PATH: store-failed, saying so', async () => {
    const store = logStoreFrom({ PATH: '/nowhere', ABE_LOG_STORE: 's3://abe-logs-test' });

    expect(await store?.list('demo/')).toEqual({
      ok: false,
      error: {
        code: 'store-failed',
        message: 'cannot list s3://abe-logs-test/demo/: aws is not installed (not on PATH)',
      },
    });
  });

  test('an s3:// that names no bucket, or not one: bad-log-store at every call', async () => {
    for (const [named, problem] of [
      ['s3://', 'not an S3 bucket name: (none)'],
      ['s3://Not_A_Bucket', 'not an S3 bucket name: Not_A_Bucket'],
      ['s3://abe-logs/a//b', 'not a key prefix (an empty part): a//b'],
      ['s3://abe-logs/../x', 'not a key prefix (. or ..): ../x'],
    ] as const) {
      const store = logStoreFrom({ PATH: s3.path, ABE_LOG_STORE: named });

      expect(await store?.list('')).toEqual({
        ok: false,
        error: { code: 'bad-log-store', message: `ABE_LOG_STORE ${named}: ${problem}` },
      });
    }
  });

  test('another kind of store is refused, naming both kinds Abe has', async () => {
    const store = logStoreFrom({ ABE_LOG_STORE: 'gs://abe-logs' });

    expect(await store?.get('demo/x')).toEqual({
      ok: false,
      error: {
        code: 'bad-log-store',
        message:
          'ABE_LOG_STORE gs://abe-logs: a log store is file://<dir> or s3://<bucket>[/<prefix>]',
      },
    });
  });
});
