/**
 * The log store `$ABE_LOG_STORE` names: a folder (`file://<dir>`, the org store's folder adapter,
 * each key a file written whole through a rename) or an S3 bucket (`s3://<bucket>[/<prefix>]`,
 * `s3-store.ts`). Also the reading of a session's log files where they are (core's
 * `logSourcesOf`).
 */
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LogSources, type LogsRead, type LogStore } from '@abe/core';
import { awsRunner } from './aws';
import { type Env } from '../mac/locations';
import { fileOrgStore } from './org-store';
import { parseS3Url, s3LogStore } from './s3-store';

const fail = (code: string, message: string) => ({ ok: false, error: { code, message } }) as const;

/** One aws call of the S3 store: a big transcript's put, a list paging through 90 days of keys. */
const S3_TIMEOUT_MS = 120_000;

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const fileLogStore = (dir: string): LogStore => {
  const folder = fileOrgStore(dir);

  return { put: folder.put, get: folder.get, list: folder.list };
};

const refusingStore = (code: string, message: string): LogStore => ({
  put: () => Promise.resolve(fail(code, message)),
  get: () => Promise.resolve(fail(code, message)),
  list: () => Promise.resolve(fail(code, message)),
});

/**
 * The log store `$ABE_LOG_STORE` names (`file://<dir>`, or `s3://<bucket>[/<prefix>]` on `env`'s
 * AWS), or `undefined` when it names none. Any other kind is refused at every call, saying so.
 */
export const logStoreFrom = (env: Env): LogStore | undefined => {
  const named = env.ABE_LOG_STORE ?? '';

  if (named === '') return undefined;
  if (named.startsWith('file://')) {
    try {
      return fileLogStore(fileURLToPath(named));
    } catch (err) {
      return refusingStore('bad-log-store', `ABE_LOG_STORE ${named}: ${why(err)}`);
    }
  }

  if (named.startsWith('s3://')) {
    const url = parseS3Url(named);

    return 'problem' in url
      ? refusingStore('bad-log-store', `ABE_LOG_STORE ${named}: ${url.problem}`)
      : s3LogStore({ ...url, aws: awsRunner(env, S3_TIMEOUT_MS) });
  }

  return refusingStore(
    'bad-log-store',
    `ABE_LOG_STORE ${named}: a log store is file://<dir> or s3://<bucket>[/<prefix>]`,
  );
};

const isMissing = (err: unknown) =>
  err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');

type Read = { text: string } | { skipped: string } | undefined;

/** Whether `path`, links resolved, is inside `within` (links resolved too). */
const inside = async (path: string, within: string) => {
  const [real, root] = await Promise.all([realpath(path), realpath(within)]);

  return real.startsWith(`${root}/`);
};

/**
 * The file as UTF-8 text: `undefined` when it is not there, `skipped` when it is a link, lies
 * outside `within`, cannot be read, or is not text (a screenshot cannot be redacted).
 */
const textOf = async (path: string, within: string): Promise<Read> => {
  try {
    if ((await lstat(path)).isSymbolicLink()) return { skipped: 'a link' };
    if (!(await inside(path, within))) return { skipped: `outside ${within}` };
    const bytes = await readFile(path);

    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      return { skipped: 'not UTF-8 text' };
    }
  } catch (err) {
    return isMissing(err) ? undefined : { skipped: why(err) };
  }
};

/** Every regular file under `dir` (links not followed), relative to it with `/`. */
const filesUnder = async (dir: string, within: string): Promise<string[] | { skipped: string }> => {
  try {
    if ((await lstat(dir)).isSymbolicLink()) return { skipped: 'a link' };
    if (!(await inside(dir, within))) return { skipped: `outside ${within}` };
    const found = await readdir(dir, { recursive: true, withFileTypes: true });

    return found
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name).slice(dir.length + 1))
      .sort();
  } catch (err) {
    return isMissing(err) ? [] : { skipped: why(err) };
  }
};

/**
 * The session's log files read now, by their name in the store: each of `files` that is there,
 * and every file under each of `dirs` as `<dir name>/<path>`. One that is not there is left out;
 * one that cannot be shipped (a link, outside its folder, unreadable, not text) is `skipped`.
 */
export const readLogSources = async (sources: LogSources): Promise<LogsRead> => {
  const files: { name: string; text: string }[] = [];
  const skipped: { name: string; why: string }[] = [];
  const take = (name: string, read: Read) => {
    if (read === undefined) return;
    if ('text' in read) files.push({ name, text: read.text });
    else skipped.push({ name, why: read.skipped });
  };

  for (const f of sources.files) take(f.name, await textOf(f.path, f.within));
  for (const d of sources.dirs) {
    const under = await filesUnder(d.path, d.within);

    if (!Array.isArray(under)) skipped.push({ name: d.name, why: under.skipped });
    else
      for (const rel of under) take(`${d.name}/${rel}`, await textOf(join(d.path, rel), d.within));
  }

  return { files, skipped };
};
