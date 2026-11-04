/**
 * A store as an S3 bucket through the `aws` CLI, on `serve`'s own AWS: the box's instance role on
 * a box, the person's SSO profile (`AWS_PROFILE`) on the Mac. The log store
 * (`$ABE_LOG_STORE=s3://<bucket>[/<prefix>]`, #58) and the org store (`$ABE_ORG_STORE`, #82) are
 * each one bucket in the tooling account; the bucket encrypts what it holds and its policy fences
 * who may write, so a refused put is the store failing, AWS's words kept. Bodies go through
 * temporary files, so bytes stay bytes.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Answered,
  type LogStore,
  orgKeyProblem,
  type OrgStore,
  type StoredObject,
} from '@abe/core';
import { z } from 'zod';
import { type AwsCli } from './aws';

const fail = (code: string, message: string) => ({ ok: false, error: { code, message } }) as const;

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `list-objects-v2 --output json`, its pages merged by the CLI; no `Contents` when empty. */
const Listed = z.object({
  Contents: z.array(z.object({ Key: z.string(), Size: z.number() })).nullish(),
});

/** S3's own error code in what the CLI printed: `An error occurred (NoSuchKey) when …`. */
const s3Code = (message: string) => /An error occurred \(([A-Za-z]+)\)/.exec(message)?.[1];

/** `undefined` when `prefix` can be listed: its folder part (to the last `/`) is a key's. */
const prefixProblem = (prefix: string) => {
  const folder = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';

  return folder === '' ? undefined : orgKeyProblem(folder);
};

export type S3StoreOptions = {
  bucket: string;
  /** Where the store's keys start in the bucket (`''` for its root), without a trailing `/`. */
  prefix: string;
  aws: AwsCli;
};

/** The log store's bucket. */
export const s3LogStore = (o: S3StoreOptions): LogStore => s3Store(o, 'log store');

/** The org store's bucket (#82): Sheets attached to cards, prototypes Make card uploaded. */
export const s3OrgStore = (o: S3StoreOptions): OrgStore => s3Store(o, 'org store');

/** Either store on a bucket; `name` is what its refusals call it. */
const s3Store = (o: S3StoreOptions, name: string): LogStore & OrgStore => {
  const base = o.prefix === '' ? '' : `${o.prefix}/`;
  const where = (key: string) => `s3://${o.bucket}/${base}${key}`;

  /** Runs `use` with a temporary folder of its own, removed after; what throws is `store-failed`. */
  const scratch = async <T>(use: (dir: string) => Promise<Answered<T>>): Promise<Answered<T>> => {
    let dir: string;

    try {
      dir = await mkdtemp(join(tmpdir(), 'abe-s3-'));
    } catch (err) {
      return fail('store-failed', `no temporary folder for the ${name}: ${why(err)}`);
    }
    try {
      return await use(dir);
    } catch (err) {
      return fail('store-failed', `the ${name}'s temporary file: ${why(err)}`);
    } finally {
      // A temporary folder left behind is the OS's to clear; the answer stands.
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  return {
    put: (key, body, contentType) => {
      const problem = orgKeyProblem(key);

      if (problem !== undefined)
        return Promise.resolve(fail('bad-key', `not a ${name} key (${problem}): ${key}`));

      return scratch(async (dir) => {
        const file = join(dir, 'body');

        await writeFile(file, body);
        const put = await o.aws([
          's3api',
          'put-object',
          '--bucket',
          o.bucket,
          '--key',
          `${base}${key}`,
          '--body',
          file,
          '--content-type',
          contentType,
          '--output',
          'json',
        ]);

        return put.ok
          ? { ok: true, data: { key, size: body.byteLength } }
          : fail('store-failed', `cannot write ${where(key)}: ${put.error.message}`);
      });
    },
    get: (key) => {
      const problem = orgKeyProblem(key);

      if (problem !== undefined)
        return Promise.resolve(fail('bad-key', `not a ${name} key (${problem}): ${key}`));

      return scratch(async (dir) => {
        const file = join(dir, 'body');
        const got = await o.aws([
          's3api',
          'get-object',
          '--bucket',
          o.bucket,
          '--key',
          `${base}${key}`,
          '--output',
          'json',
          file,
        ]);

        if (!got.ok)
          return s3Code(got.error.message) === 'NoSuchKey'
            ? fail('not-found', `the ${name} has no ${key}`)
            : fail('store-failed', `cannot read ${where(key)}: ${got.error.message}`);
        try {
          return { ok: true, data: new Uint8Array(await readFile(file)) };
        } catch (err) {
          return fail('store-failed', `cannot read ${where(key)}: ${why(err)}`);
        }
      });
    },
    list: async (prefix) => {
      const problem = prefixProblem(prefix);

      if (problem !== undefined) return fail('bad-key', `not a ${name} prefix: ${prefix}`);
      const listed = await o.aws([
        's3api',
        'list-objects-v2',
        '--bucket',
        o.bucket,
        '--prefix',
        `${base}${prefix}`,
        '--output',
        'json',
      ]);

      if (!listed.ok)
        return fail('store-failed', `cannot list ${where(prefix)}: ${listed.error.message}`);
      let json: unknown;

      try {
        json = listed.data.trim() === '' ? {} : JSON.parse(listed.data);
      } catch {
        return fail('store-failed', `aws s3api list-objects-v2 answered no JSON`);
      }
      const read = Listed.safeParse(json);

      if (!read.success)
        return fail('store-failed', 'aws s3api list-objects-v2 answered a shape Abe does not read');
      const objects: StoredObject[] = (read.data.Contents ?? [])
        .filter((c) => c.Key.startsWith(base))
        .map((c) => ({ key: c.Key.slice(base.length), size: c.Size }));

      return { ok: true, data: objects.sort((a, b) => a.key.localeCompare(b.key)) };
    },
  };
};

/** An S3 bucket's name as S3 allows it (3–63 of a-z 0-9 . -, a letter or digit at each end). */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * `s3://<bucket>[/<prefix>]` read: the bucket and the prefix (its parts each a key's, no trailing
 * `/`), or why it is not one.
 */
export const parseS3Url = (
  url: string,
): { bucket: string; prefix: string } | { problem: string } => {
  const rest = url.slice('s3://'.length);
  const slash = rest.indexOf('/');
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const prefix = slash === -1 ? '' : rest.slice(slash + 1).replace(/\/+$/, '');

  if (!BUCKET.test(bucket))
    return { problem: `not an S3 bucket name: ${bucket === '' ? '(none)' : bucket}` };
  const problem = prefix === '' ? undefined : orgKeyProblem(prefix);

  return problem === undefined
    ? { bucket, prefix }
    : { problem: `not a key prefix (${problem}): ${prefix}` };
};
