/**
 * The org store `$ABE_ORG_STORE` names: a folder (`file://<dir>`: each key a file under it, written
 * whole through a temporary file renamed over; tests and a lone Mac) or the org's bucket in the
 * tooling account (`s3://<bucket>[/<prefix>]`, `s3-store.ts`, #82: abe-org's
 * `terraform/org-store`).
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Answered, orgKeyProblem, type OrgStore, type StoredObject } from '@abe/core';
import { awsRunner } from './aws';
import { type Env } from '../mac/locations';
import { parseS3Url, s3OrgStore } from './s3-store';

const fail = (code: string, message: string) => ({ ok: false, error: { code, message } }) as const;

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

const isMissing = (err: unknown) =>
  err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');

/** Temporary files a write leaves while it runs; never listed. */
const TEMP = '.tmp-';

let written = 0;

export const fileOrgStore = (dir: string): OrgStore => {
  const checked = <T>(
    key: string,
    then: (path: string) => Promise<Answered<T>>,
  ): Promise<Answered<T>> => {
    const problem = orgKeyProblem(key);

    return problem === undefined
      ? then(join(dir, ...key.split('/')))
      : Promise.resolve(fail('bad-key', `not an org store key (${problem}): ${key}`));
  };

  const walk = async (folder: string): Promise<string[]> => {
    let names;

    try {
      names = await readdir(folder, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    const found = await Promise.all(
      names.map((d) => {
        const path = join(folder, d.name);

        if (d.isDirectory()) return walk(path);

        return Promise.resolve(d.isFile() && !d.name.startsWith(TEMP) ? [path] : []);
      }),
    );

    return found.flat();
  };

  return {
    put: (key, body) =>
      checked(key, async (path) => {
        try {
          await mkdir(dirname(path), { recursive: true });
          written += 1;
          const temp = join(dirname(path), `${TEMP}${process.pid}-${written}`);

          await writeFile(temp, body);
          await rename(temp, path);

          return { ok: true, data: { key, size: body.byteLength } };
        } catch (err) {
          return fail('store-failed', `cannot write ${key} to the org store: ${why(err)}`);
        }
      }),
    get: (key) =>
      checked(key, async (path) => {
        try {
          return { ok: true, data: new Uint8Array(await readFile(path)) };
        } catch (err) {
          return isMissing(err)
            ? fail('not-found', `the org store has no ${key}`)
            : fail('store-failed', `cannot read ${key} from the org store: ${why(err)}`);
        }
      }),
    list: async (prefix) => {
      // Only the folder the prefix's last `/` names is walked; keys are matched on the whole prefix.
      const folder = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';

      if (folder !== '' && orgKeyProblem(folder) !== undefined)
        return fail('bad-key', `not an org store prefix: ${prefix}`);
      try {
        const files = await walk(join(dir, ...folder.split('/').filter((p) => p !== '')));
        const objects: StoredObject[] = [];

        for (const file of files) {
          const key = relative(dir, file).split(sep).join('/');

          if (key.startsWith(prefix)) objects.push({ key, size: (await stat(file)).size });
        }

        return { ok: true, data: objects.sort((a, b) => a.key.localeCompare(b.key)) };
      } catch (err) {
        return fail('store-failed', `cannot list ${prefix} in the org store: ${why(err)}`);
      }
    },
  };
};

/** A store whose every call fails with the same reason: one Abe cannot use. */
const refusingStore = (code: string, message: string): OrgStore => ({
  put: () => Promise.resolve(fail(code, message)),
  get: () => Promise.resolve(fail(code, message)),
  list: () => Promise.resolve(fail(code, message)),
});

/** One aws call of the S3 store: a version's screenshot, a list of every card's prototypes. */
const S3_TIMEOUT_MS = 120_000;

/**
 * The org store `$ABE_ORG_STORE` names (`file://<dir>`, or `s3://<bucket>[/<prefix>]` on `env`'s
 * AWS), or `undefined` when it names none. Any other kind is refused at every call, saying so.
 */
export const orgStoreFrom = (env: Env): OrgStore | undefined => {
  const named = env.ABE_ORG_STORE ?? '';

  if (named === '') return undefined;
  if (named.startsWith('file://')) {
    try {
      return fileOrgStore(fileURLToPath(named));
    } catch (err) {
      return refusingStore('bad-org-store', `ABE_ORG_STORE ${named}: ${why(err)}`);
    }
  }

  if (named.startsWith('s3://')) {
    const url = parseS3Url(named);

    return 'problem' in url
      ? refusingStore('bad-org-store', `ABE_ORG_STORE ${named}: ${url.problem}`)
      : s3OrgStore({ ...url, aws: awsRunner(env, S3_TIMEOUT_MS) });
  }

  return refusingStore(
    'bad-org-store',
    `ABE_ORG_STORE ${named}: an org store is file://<dir> or s3://<bucket>[/<prefix>]`,
  );
};
